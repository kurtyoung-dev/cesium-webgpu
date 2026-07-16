/**
 * Canonical ordering fields shared by WebGL DrawCommand, WebGPU draw commands,
 * collection render packets, and CPU/GPU sorters.
 *
 * Collection APIs expose `renderLayer` / `renderPriority`. Those names are
 * mapped once, before renderer selection, into this command-facing schema.
 * `materialSortId` remains zero until the stable material allocator assigns it.
 *
 * @private
 */

const DEFAULT_COMMAND_SORT_LAYER = 50;
const DEFAULT_COMMAND_SORT_PRIORITY = 0;
const DEFAULT_COMMAND_MATERIAL_SORT_ID = 0;
const MAX_COMMAND_SORT_BYTE = 0xff;
const MAX_COMMAND_MATERIAL_SORT_ID = 0xffff;

/**
 * Canonicalizes a public layer/priority value to the exact unsigned byte
 * represented by the packed WASM and GPU sort paths. Saturation (rather than
 * bit masking) preserves ordering at the contract boundaries: -1 aliases 0
 * and 256 aliases 255 instead of wrapping to the opposite end.
 *
 * @param {number|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeCommandSortByte(value, fallback) {
  const numeric = value ?? fallback;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(MAX_COMMAND_SORT_BYTE, Math.max(0, Math.trunc(numeric)));
}

/**
 * @param {number|undefined} value
 * @returns {number}
 */
function normalizeCommandMaterialSortId(value) {
  const numeric = value ?? DEFAULT_COMMAND_MATERIAL_SORT_ID;
  if (!Number.isFinite(numeric)) {
    return DEFAULT_COMMAND_MATERIAL_SORT_ID;
  }
  return Math.min(
    MAX_COMMAND_MATERIAL_SORT_ID,
    Math.max(0, Math.trunc(numeric)),
  );
}

/**
 * The current 64-bit GPU key has no field for Cesium's legacy `sortKey`.
 * A command list is therefore eligible for GPU ordering only while every
 * legacy key is the canonical zero. Non-zero keys must remain on the CPU
 * comparator until a wider lossless GPU key is implemented.
 *
 * @param {object} command
 * @returns {boolean}
 */
function isCommandOrderingGPUEncodable(command) {
  return (command.sortKey ?? 0) === 0;
}

/**
 * Evaluate the canonical distance term used by Cesium's live command
 * comparators. Bounding volumes such as oriented boxes intentionally measure
 * distance to their surface, not to `boundingVolume.center`; reconstructing a
 * center distance in the GPU path changes ordering semantics and also loses
 * precision when Earth-scale centers are down-cast before subtraction.
 *
 * Undefined is returned when the command cannot provide a finite canonical
 * value. GPU sorting must keep the complete list on the CPU in that case,
 * matching CommandSorter which treats a missing distance function as an
 * unsortable/equal pair.
 *
 * @param {object} command
 * @param {{x:number,y:number,z:number}} position
 * @returns {number|undefined}
 */
function getCommandDistanceSquaredForSort(command, position) {
  const boundingVolume = command?.boundingVolume;
  const distanceSquaredTo = boundingVolume?.distanceSquaredTo;
  if (typeof distanceSquaredTo !== "function") {
    return undefined;
  }
  const distanceSquared = distanceSquaredTo.call(boundingVolume, position);
  return Number.isFinite(distanceSquared) ? distanceSquared : undefined;
}

/**
 * @typedef {object} CommandOrdering
 * @property {number} sortLayer
 * @property {number} sortPriority
 * @property {number} materialSortId
 */

/**
 * Creates the reusable semantic ordering packet owned by a collection.
 * This is called during construction, not from the per-frame render hot path.
 *
 * @param {number} [sortLayer=DEFAULT_COMMAND_SORT_LAYER]
 * @param {number} [sortPriority=DEFAULT_COMMAND_SORT_PRIORITY]
 * @param {number} [materialSortId=DEFAULT_COMMAND_MATERIAL_SORT_ID]
 * @returns {CommandOrdering}
 */
function createCommandOrdering(sortLayer, sortPriority, materialSortId) {
  return {
    sortLayer: normalizeCommandSortByte(sortLayer, DEFAULT_COMMAND_SORT_LAYER),
    sortPriority: normalizeCommandSortByte(
      sortPriority,
      DEFAULT_COMMAND_SORT_PRIORITY,
    ),
    materialSortId: normalizeCommandMaterialSortId(materialSortId),
  };
}

/**
 * Snapshots a collection's public ordering fields into its reusable canonical
 * packet. Collection update methods call this before choosing a renderer.
 *
 * @param {{
 *   renderLayer?: number,
 *   renderPriority?: number,
 *   _commandOrdering: CommandOrdering,
 * }} collection
 * @returns {CommandOrdering}
 */
function syncCollectionCommandOrdering(collection) {
  const ordering = collection._commandOrdering;
  ordering.sortLayer = normalizeCommandSortByte(
    collection.renderLayer,
    DEFAULT_COMMAND_SORT_LAYER,
  );
  ordering.sortPriority = normalizeCommandSortByte(
    collection.renderPriority,
    DEFAULT_COMMAND_SORT_PRIORITY,
  );
  return ordering;
}

/**
 * Copies a canonical packet to a DrawCommand-like object. A material ID that
 * was already assigned to a cached command is preserved.
 *
 * @param {object} command
 * @param {CommandOrdering} ordering
 * @returns {object}
 */
function applyCommandOrdering(command, ordering) {
  command.sortLayer = normalizeCommandSortByte(
    ordering.sortLayer,
    DEFAULT_COMMAND_SORT_LAYER,
  );
  command.sortPriority = normalizeCommandSortByte(
    ordering.sortPriority,
    DEFAULT_COMMAND_SORT_PRIORITY,
  );
  if (command.materialSortId === undefined) {
    command.materialSortId = normalizeCommandMaterialSortId(
      ordering.materialSortId,
    );
  }
  return command;
}

/**
 * Canonicalizes one command's mutable ordering fields in place. Commands
 * normalize these fields at construction, but they remain public and legacy
 * callers may mutate them afterward. Sort entry points call this once per
 * command so the O(N log N) comparator can stay arithmetic-only without
 * changing saturation or fallback semantics.
 *
 * @param {object} command
 * @returns {object}
 */
function normalizeCommandOrdering(command) {
  const sortLayer = normalizeCommandSortByte(
    command.sortLayer,
    DEFAULT_COMMAND_SORT_LAYER,
  );
  const sortPriority = normalizeCommandSortByte(
    command.sortPriority,
    DEFAULT_COMMAND_SORT_PRIORITY,
  );
  const materialSortId = normalizeCommandMaterialSortId(command.materialSortId);

  if (command.sortLayer !== sortLayer) {
    command.sortLayer = sortLayer;
  }
  if (command.sortPriority !== sortPriority) {
    command.sortPriority = sortPriority;
  }
  if (command.materialSortId !== materialSortId) {
    command.materialSortId = materialSortId;
  }
  return command;
}

/**
 * Canonicalizes an active command-list prefix in one linear pass.
 *
 * @param {object[]} commands
 * @param {number} [count=commands.length]
 * @returns {object[]}
 */
function normalizeCommandOrderingList(commands, count) {
  const length = Math.min(commands.length, count ?? commands.length);
  for (let i = 0; i < length; i++) {
    normalizeCommandOrdering(commands[i]);
  }
  return commands;
}

/**
 * Compares the shared ordering prefix used by CPU command sorters. Render
 * layer is authoritative before the legacy sort key and public priority.
 * Opaque callers additionally compare stable material IDs.
 *
 * @param {object} a
 * @param {object} b
 * @param {boolean} [compareMaterial=false]
 * @returns {number}
 */
function compareCommandOrdering(a, b, compareMaterial) {
  const layerDifference =
    (a.sortLayer ?? DEFAULT_COMMAND_SORT_LAYER) -
    (b.sortLayer ?? DEFAULT_COMMAND_SORT_LAYER);
  if (layerDifference !== 0) {
    return layerDifference;
  }

  const sortKeyDifference = (a.sortKey ?? 0) - (b.sortKey ?? 0);
  if (sortKeyDifference !== 0) {
    return sortKeyDifference;
  }

  const priorityDifference =
    (a.sortPriority ?? DEFAULT_COMMAND_SORT_PRIORITY) -
    (b.sortPriority ?? DEFAULT_COMMAND_SORT_PRIORITY);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  if (compareMaterial) {
    return (
      (a.materialSortId ?? DEFAULT_COMMAND_MATERIAL_SORT_ID) -
      (b.materialSortId ?? DEFAULT_COMMAND_MATERIAL_SORT_ID)
    );
  }

  return 0;
}

export {
  DEFAULT_COMMAND_MATERIAL_SORT_ID,
  DEFAULT_COMMAND_SORT_LAYER,
  DEFAULT_COMMAND_SORT_PRIORITY,
  MAX_COMMAND_MATERIAL_SORT_ID,
  MAX_COMMAND_SORT_BYTE,
  applyCommandOrdering,
  compareCommandOrdering,
  createCommandOrdering,
  getCommandDistanceSquaredForSort,
  isCommandOrderingGPUEncodable,
  normalizeCommandOrdering,
  normalizeCommandOrderingList,
  normalizeCommandMaterialSortId,
  normalizeCommandSortByte,
  syncCollectionCommandOrdering,
};

const CommandOrdering = {
  DEFAULT_COMMAND_MATERIAL_SORT_ID,
  DEFAULT_COMMAND_SORT_LAYER,
  DEFAULT_COMMAND_SORT_PRIORITY,
  MAX_COMMAND_MATERIAL_SORT_ID,
  MAX_COMMAND_SORT_BYTE,
  applyCommandOrdering,
  compareCommandOrdering,
  createCommandOrdering,
  getCommandDistanceSquaredForSort,
  isCommandOrderingGPUEncodable,
  normalizeCommandOrdering,
  normalizeCommandOrderingList,
  normalizeCommandMaterialSortId,
  normalizeCommandSortByte,
  syncCollectionCommandOrdering,
};

export default CommandOrdering;
