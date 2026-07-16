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
 * @param {object} [options] Configuration options.
 * @param {boolean} [options.enabled=false] Whether duplicate layer binning and
 *   sorting are active. The stable material-ID service remains available while
 *   disabled.
 *
 * @alias RenderScheduler
 * @private
 */
class RenderScheduler {
  constructor(options) {
    options = options ?? {};

    /**
     * Whether the scheduler is active. When false, Scene.js uses legacy sorting.
     * @type {boolean}
     * @default false
     */
    this.enabled = options.enabled ?? false;

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
     */
    this._stats = {
      commandsBinned: 0,
      layersRendered: 0,
      depthClears: 0,
      materialBatches: 0,
      materialIdsAssigned: 0,
      sortCalls: 0,
    };

    /**
     * C9-08 demand gate. Stable material sort IDs are only maintained on the
     * default (scheduler-disabled) path when a declared consumer needs them.
     * External systems that read `materialSortId` off the raw command stream
     * register demand through {@link RenderScheduler#requireStableMaterialIds}.
     * @type {number}
     * @private
     */
    this._stableMaterialIdConsumers = 0;

    /**
     * Cumulative count of frames where the default-path stable-material-ID
     * maintenance loop actually ran (a consumer was present). Monotonic —
     * NOT reset per frame — so counter-evidence probes can observe demand
     * gating over a moving route.
     * @type {number}
     * @private
     */
    this._materialIdMaintenanceRuns = 0;

    /**
     * Cumulative count of frames where the maintenance loop was demand-gated
     * off (no consumer) and performed zero per-command work. Monotonic.
     * @type {number}
     * @private
     */
    this._materialIdMaintenanceSkips = 0;

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

  /**
   * Per-frame rendering statistics.
   * @type {object}
   * @readonly
   */
  get stats() {
    return this._stats;
  }

  /**
   * The material sort ID allocator.
   * @type {MaterialSortIdAllocator}
   * @readonly
   */
  get materialAllocator() {
    return this._materialAllocator;
  }

  /**
   * Prepares the scheduler for a new frame. Resets all layer command buckets
   * and per-frame statistics. Called at the start of Scene.render().
   */
  beginFrame() {
    if (this.enabled) {
      this.layers.resetAllBuckets();
    }
    this._stats.commandsBinned = 0;
    this._stats.layersRendered = 0;
    this._stats.depthClears = 0;
    this._stats.materialBatches = 0;
    this._stats.materialIdsAssigned = 0;
    this._stats.sortCalls = 0;
  }

  /**
   * Assign stable material IDs without populating the scheduler's unconsumed
   * layer buckets. This is the default linear service used by Scene while the
   * duplicate scheduling architecture is contained.
   *
   * @param {object[]} commands Draw commands emitted for the current viewport.
   * @param {number} [count=commands.length] Number of live command entries.
   */
  assignMaterialSortIds(commands, count) {
    const length = Math.min(count ?? commands.length, commands.length);
    for (let i = 0; i < length; i++) {
      const command = commands[i];
      if (!defined(command)) {
        continue;
      }
      this._materialAllocator.ensureMaterialSortId(command);
      this._stats.materialIdsAssigned++;
    }
  }

  /**
   * Registers a declared consumer of stable material sort IDs. While at least
   * one consumer is registered, {@link RenderScheduler#maintainMaterialSortIds}
   * performs its linear assignment even when the scheduler itself is disabled.
   *
   * Use this for systems that read `command.materialSortId` off the raw command
   * stream via a lifetime longer than a single frame (the per-frame internal
   * consumers — GPU sort keys, pick-pass front-to-back material tiebreak — are
   * signalled directly through the `consumerDemanded` argument instead).
   *
   * @returns {function} A release function; call it once to drop the demand.
   */
  requireStableMaterialIds() {
    this._stableMaterialIdConsumers++;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this._stableMaterialIdConsumers = Math.max(
        0,
        this._stableMaterialIdConsumers - 1,
      );
    };
  }

  /**
   * Whether any long-lived consumer currently requires stable material IDs.
   * @type {boolean}
   * @readonly
   */
  get stableMaterialIdsRequested() {
    return this._stableMaterialIdConsumers > 0;
  }

  /**
   * Number of registered long-lived stable-material-ID consumers.
   * @type {number}
   * @readonly
   */
  get stableMaterialIdConsumers() {
    return this._stableMaterialIdConsumers;
  }

  /**
   * Cumulative frames the default-path maintenance loop ran (consumer present).
   * @type {number}
   * @readonly
   */
  get materialIdMaintenanceRuns() {
    return this._materialIdMaintenanceRuns;
  }

  /**
   * Cumulative frames the default-path maintenance loop was demand-gated off.
   * @type {number}
   * @readonly
   */
  get materialIdMaintenanceSkips() {
    return this._materialIdMaintenanceSkips;
  }

  /**
   * C9-08 default-path stable-material-ID maintenance, demand-gated. Runs the
   * linear {@link RenderScheduler#assignMaterialSortIds} pass ONLY when a
   * declared consumer needs stable IDs this frame; otherwise performs zero
   * per-command work and records the skip for containment truthfulness.
   *
   * When no consumer is present the raw command stream keeps its construction
   * default (`materialSortId === 0`), which the default render path never reads
   * — so skipping is byte-identical. When a consumer IS present (pick-pass
   * front-to-back material tiebreak, GPU sort keys, or a registered long-lived
   * consumer) the assignment runs exactly as before, preserving output.
   *
   * @param {object[]} commands The raw command list for the current viewport.
   * @param {boolean} [consumerDemanded=false] Whether a per-frame internal
   *   consumer needs stable IDs this frame.
   * @param {number} [count=commands.length] Number of live command entries.
   * @returns {boolean} Whether the maintenance loop ran.
   */
  maintainMaterialSortIds(commands, consumerDemanded, count) {
    if (consumerDemanded !== true && !this.stableMaterialIdsRequested) {
      this._materialIdMaintenanceSkips++;
      return false;
    }
    this.assignMaterialSortIds(commands, count);
    this._materialIdMaintenanceRuns++;
    return true;
  }

  /**
   * Bins a single command into the appropriate render layer.
   * Auto-populates materialSortId if not set.
   *
   * @param {object} command A DrawCommand or WebGPUDrawCommand.
   * @param {boolean} isTranslucent Whether the command is translucent.
   */
  binCommand(command, isTranslucent) {
    // Auto-populate materialSortId from shader program
    this._materialAllocator.ensureMaterialSortId(command);
    this._stats.materialIdsAssigned++;

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
  }

  /**
   * Sorts all commands within each layer according to the layer's configured
   * sort mode. Call this after all commands have been binned.
   *
   * @param {object} cameraPosition The camera position in world coordinates.
   */
  sortAllLayers(cameraPosition) {
    this._stats.sortCalls++;
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
  }

  /**
   * Returns the sorted array of enabled layers with their command buckets.
   * @returns {RenderLayer[]}
   */
  getEnabledLayers() {
    this.layers._ensureSorted();
    return this.layers._layers;
  }

  /**
   * Predicts the sort position of a hypothetical command.
   * @param {object} options Query options.
   * @returns {object} Prediction result.
   */
  predictSortPosition(options) {
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
  }

  /**
   * Explains why command A renders before/after command B.
   * @param {object} commandA A DrawCommand or WebGPUDrawCommand.
   * @param {object} commandB A DrawCommand or WebGPUDrawCommand.
   * @param {object} cameraPosition The camera position for distance calculation.
   * @returns {string} A multi-line explanation.
   */
  explainRenderOrder(commandA, commandB, cameraPosition) {
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
  }

  /**
   * Returns a diagnostic summary of the current frame's sort state.
   * @returns {string}
   */
  getDiagnostics() {
    const lines = [
      `=== RenderScheduler (${this.enabled ? "ENABLED" : "DISABLED"}) ===`,
      `Commands binned: ${this._stats.commandsBinned}`,
      `Materials tracked: ${this._materialAllocator.count}`,
      "",
      this.layers.getDiagnostics(),
    ];
    return lines.join("\n");
  }

  /**
   * Convenience wrapper around predictSortPosition for Entity API users.
   * @param {object} entity An Entity with a renderPriority property.
   * @param {object} [options] Additional options.
   * @returns {object} Prediction result.
   */
  predictEntitySortPosition(entity, options) {
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
  }

  /**
   * Returns the sort order decision tree documentation.
   * @returns {string}
   */
  getSortOrderDocumentation() {
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
  }
}

// ====================================================================
// FILE-SCOPED SORT COMPARATORS
// ====================================================================

function opaqueMaterialMeshSort(a, b, position) {
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

  const matA = a.materialSortId ?? 0;
  const matB = b.materialSortId ?? 0;
  if (matA !== matB) {
    return matA - matB;
  }

  // Guard against commands without a boundingVolume (e.g., ClearCommand, overlay commands)
  const bvA = a.boundingVolume;
  const bvB = b.boundingVolume;
  if (!bvA || !bvB) {
    return 0;
  }
  return bvA.distanceSquaredTo(position) - bvB.distanceSquaredTo(position);
}

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

  const bvA = a.boundingVolume;
  const bvB = b.boundingVolume;
  if (!bvA || !bvB) {
    return 0;
  }
  return bvA.distanceSquaredTo(position) - bvB.distanceSquaredTo(position);
}

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

  const bvA = a.boundingVolume;
  const bvB = b.boundingVolume;
  if (!bvA || !bvB) {
    return 0;
  }
  return bvB.distanceSquaredTo(position) - bvA.distanceSquaredTo(position);
}

function manualSort(a, b) {
  const sortKeyA = a.sortKey ?? 0;
  const sortKeyB = b.sortKey ?? 0;
  if (sortKeyA !== sortKeyB) {
    return sortKeyA - sortKeyB;
  }

  return (a.sortPriority ?? 0) - (b.sortPriority ?? 0);
}

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
    return;
  }

  if (count < commands.length) {
    const savedLength = commands.length;
    commands.length = count;
    mergeSort(commands, comparator, cameraPosition);
    commands.length = savedLength;
  } else {
    mergeSort(commands, comparator, cameraPosition);
  }
}

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
