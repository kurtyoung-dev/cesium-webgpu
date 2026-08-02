import Cartesian3 from "../../Core/Cartesian3.js";

/**
 * C11-205 — immutable, versioned snapshot of the broad tileset state copied
 * into every Model3DTileContent. Dynamic per-tile state (model matrix,
 * clipping, reference matrix, and environment-map ownership) deliberately
 * remains outside this packet.
 *
 * @private
 */

function sameScalar(left, right) {
  return Object.is(left, right);
}

function sameCartesian3(left, right) {
  const leftAbsent = left === undefined || left === null;
  const rightAbsent = right === undefined || right === null;
  if (leftAbsent || rightAbsent) {
    return leftAbsent && rightAbsent;
  }
  return (
    Object.is(left.x, right.x) &&
    Object.is(left.y, right.y) &&
    Object.is(left.z, right.z)
  );
}

function cloneCartesian3(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return Object.freeze(Cartesian3.clone(value));
}

function packetMatchesTileset(packet, tileset) {
  return (
    sameScalar(packet.colorBlendAmount, tileset.colorBlendAmount) &&
    sameScalar(packet.colorBlendMode, tileset.colorBlendMode) &&
    packet.customShader === tileset.customShader &&
    sameScalar(packet.featureIdLabel, tileset.featureIdLabel) &&
    sameScalar(packet.instanceFeatureIdLabel, tileset.instanceFeatureIdLabel) &&
    sameCartesian3(packet.lightColor, tileset.lightColor) &&
    packet.imageBasedLighting === tileset.imageBasedLighting &&
    sameScalar(packet.backFaceCulling, tileset.backFaceCulling) &&
    sameScalar(packet.shadows, tileset.shadows) &&
    sameScalar(packet.showCreditsOnScreen, tileset.showCreditsOnScreen) &&
    sameScalar(packet.splitDirection, tileset.splitDirection) &&
    sameScalar(packet.debugWireframe, tileset.debugWireframe) &&
    sameScalar(packet.edgeDisplayMode, tileset.edgeDisplayMode) &&
    sameScalar(packet.showOutline, tileset.showOutline) &&
    packet.outlineColor === tileset.outlineColor &&
    packet.pointCloudShading === tileset.pointCloudShading
  );
}

function createPacket(tileset, version) {
  return Object.freeze({
    version,
    colorBlendAmount: tileset.colorBlendAmount,
    colorBlendMode: tileset.colorBlendMode,
    customShader: tileset.customShader,
    featureIdLabel: tileset.featureIdLabel,
    instanceFeatureIdLabel: tileset.instanceFeatureIdLabel,
    // Model.lightColor clones its input, so retain a value snapshot to detect
    // in-place Cartesian3 edits without keeping per-model clone work hot.
    lightColor: cloneCartesian3(tileset.lightColor),
    imageBasedLighting: tileset.imageBasedLighting,
    backFaceCulling: tileset.backFaceCulling,
    shadows: tileset.shadows,
    showCreditsOnScreen: tileset.showCreditsOnScreen,
    splitDirection: tileset.splitDirection,
    debugWireframe: tileset.debugWireframe,
    edgeDisplayMode: tileset.edgeDisplayMode,
    showOutline: tileset.showOutline,
    // Model stores outlineColor by reference. Retain the exact object so an
    // in-place edit keeps propagating; replacing the object bumps the packet.
    outlineColor: tileset.outlineColor,
    pointCloudShading: tileset.pointCloudShading,
  });
}

/**
 * Refresh the tileset's shared packet at most once for an unchanged state.
 * This performs the broad comparisons once per pass rather than once per
 * selected tile. Cesium3DTileset additionally refreshes after tileVisible
 * callbacks, preserving their documented same-tile mutation behavior.
 *
 * @param {object} tileset
 * @returns {object}
 * @private
 */
function refreshModel3DTileStatePacket(tileset) {
  const current = tileset._model3DTileStatePacket;
  if (current !== undefined && packetMatchesTileset(current, tileset)) {
    return current;
  }

  const packet = createPacket(tileset, (current?.version ?? 0) + 1);
  tileset._model3DTileStatePacket = packet;
  return packet;
}

/**
 * Apply every broad property after a packet change. Changes are rare, and
 * applying the complete packet lets a content that skipped several versions
 * catch up without retaining an unbounded delta history.
 *
 * @param {object} model
 * @param {object} packet
 * @private
 */
function applyModel3DTileStatePacket(model, packet) {
  model.colorBlendAmount = packet.colorBlendAmount;
  model.colorBlendMode = packet.colorBlendMode;
  model.customShader = packet.customShader;
  model.featureIdLabel = packet.featureIdLabel;
  model.instanceFeatureIdLabel = packet.instanceFeatureIdLabel;
  model.lightColor = packet.lightColor;
  model.imageBasedLighting = packet.imageBasedLighting;
  model.backFaceCulling = packet.backFaceCulling;
  model.shadows = packet.shadows;
  model.showCreditsOnScreen = packet.showCreditsOnScreen;
  model.splitDirection = packet.splitDirection;
  model.debugWireframe = packet.debugWireframe;
  model.edgeDisplayMode = packet.edgeDisplayMode;
  model.showOutline = packet.showOutline;
  model.outlineColor = packet.outlineColor;
  model.pointCloudShading = packet.pointCloudShading;
}

const Model3DTileStatePacket = Object.freeze({
  applyModel3DTileStatePacket,
  refreshModel3DTileStatePacket,
});

export { applyModel3DTileStatePacket, refreshModel3DTileStatePacket };
export default Model3DTileStatePacket;
