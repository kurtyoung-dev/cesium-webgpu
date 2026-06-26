import * as Cesium from "cesium";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  shouldAnimate: true,
  shadows: false,
  terrain: undefined,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
});

const scene = viewer.scene;
const pickResultEl = document.getElementById("pickResult");

// Two distinct models so the user can verify pick discriminates between
// primitives. Both are local SampleData assets so no network is needed.
const truckPosition = Cesium.Cartesian3.fromDegrees(
  -123.0744619,
  44.0503706,
  0,
);
const manPosition = Cesium.Cartesian3.fromDegrees(-123.0742619, 44.0503706, 0);

function makeOrientation(position, headingDeg) {
  const heading = Cesium.Math.toRadians(headingDeg);
  const hpr = new Cesium.HeadingPitchRoll(heading, 0, 0);
  return Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
}

const truckEntity = viewer.entities.add({
  name: "Milk Truck",
  position: truckPosition,
  orientation: makeOrientation(truckPosition, 135),
  model: {
    uri: "../../SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
    minimumPixelSize: 96,
    maximumScale: 20000,
  },
});

const manEntity = viewer.entities.add({
  name: "Cesium Man",
  position: manPosition,
  orientation: makeOrientation(manPosition, 0),
  model: {
    uri: "../../SampleData/models/CesiumMan/Cesium_Man.glb",
    minimumPixelSize: 96,
    maximumScale: 20000,
  },
});

viewer.zoomTo([truckEntity, manEntity]);

// Click handler exercises `scene.pick(...)`. The Batch 54 pick command
// routes through `webgpuCmd.derivedCommands.picking.pickCommand`, the
// Batch 29 dispatcher selects it during pick passes, and the Batch 54
// `createPickId` registration provides the readback target.
const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
handler.setInputAction((movement) => {
  const picked = scene.pick(movement.position);
  if (!Cesium.defined(picked)) {
    pickResultEl.textContent = "(no model under cursor)";
    return;
  }

  const primitiveLabel = describePrimitive(picked.primitive);
  const idLabel = describeId(picked.id);
  pickResultEl.innerHTML = [
    `<span class="label">primitive:</span> ${primitiveLabel}`,
    `<span class="label">id:</span> ${idLabel}`,
  ].join("<br>");
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

function describePrimitive(p) {
  if (!Cesium.defined(p)) {
    return "(undefined)";
  }
  if (p instanceof Cesium.Model) {
    // Model attached as `entity.model` ends up as the underlying Model
    // primitive; identify it via the source URL when possible.
    return `Model[${p._resource?.url ?? "(anon)"}]`;
  }
  return p.constructor?.name ?? typeof p;
}

function describeId(id) {
  if (!Cesium.defined(id)) {
    return "(no id)";
  }
  if (id instanceof Cesium.Entity) {
    return `Entity("${id.name ?? id.id}")`;
  }
  if (typeof id === "string") {
    // Batch 54 packs the per-primitive key as the pick id payload.
    return `"${id}" (likely "nodeIdx_primIdx" from Batch 54)`;
  }
  return JSON.stringify(id);
}
