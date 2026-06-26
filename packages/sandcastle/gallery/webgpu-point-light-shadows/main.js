import * as Cesium from "cesium";
import Sandcastle from "Sandcastle";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  shouldAnimate: true,
  shadows: true,
  terrain: undefined,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
});

const scene = viewer.scene;

// Anchor everything around a flat patch — the demo's only goal is to
// make the cube-mapped shadow visible against a flat ground plane.
const center = Cesium.Cartesian3.fromDegrees(-75.59, 40.038, 0);
const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(center);

// Ground plane: a large flat box in ENU local space so the shadow has
// a surface to fall onto.
const groundEntity = viewer.entities.add({
  name: "Ground Plane",
  position: center,
  orientation: Cesium.Transforms.headingPitchRollQuaternion(
    center,
    new Cesium.HeadingPitchRoll(0, 0, 0),
  ),
  box: {
    dimensions: new Cesium.Cartesian3(200.0, 200.0, 0.5),
    material: new Cesium.Color(0.7, 0.7, 0.75, 1.0),
    shadows: Cesium.ShadowMode.RECEIVE_ONLY,
  },
});

// Caster: a glTF model 10m above the plane.
const modelPos = Cesium.Matrix4.multiplyByPoint(
  enuTransform,
  new Cesium.Cartesian3(0, 0, 10),
  new Cesium.Cartesian3(),
);
const modelEntity = viewer.entities.add({
  name: "Wood Tower",
  position: modelPos,
  orientation: Cesium.Transforms.headingPitchRollQuaternion(
    modelPos,
    new Cesium.HeadingPitchRoll(0, 0, 0),
  ),
  model: {
    uri: "../../SampleData/models/WoodTower/Wood_Tower.glb",
    shadows: Cesium.ShadowMode.CAST_ONLY,
  },
});

viewer.zoomTo([groundEntity, modelEntity]);

// Point-light setup. CesiumJS exposes a ShadowMap for the sun by
// default; for an explicit point light we instantiate one with a
// Camera positioned 30m above the model (so the cube-shadow cone
// covers the model + plane). The Batch 34 cast pipeline detects this
// via `shadowMap._isPointLight`, the Batch 57 receive path consumes
// the published cube depth at binding 17 of the effects bind group.
let pointLightShadowMap;
const lightPosLocal = new Cesium.Cartesian3(0, 0, 30);
const lightPosWC = Cesium.Matrix4.multiplyByPoint(
  enuTransform,
  lightPosLocal,
  new Cesium.Cartesian3(),
);

try {
  const lightCamera = new Cesium.Camera(scene);
  lightCamera.position = lightPosWC;
  lightCamera.frustum = new Cesium.PerspectiveFrustum({
    fov: Cesium.Math.PI_OVER_TWO,
    aspectRatio: 1.0,
    near: 1.0,
    far: 100.0,
  });

  pointLightShadowMap = new Cesium.ShadowMap({
    context: scene.context,
    lightCamera: lightCamera,
    isPointLight: true,
    pointLightRadius: 100.0,
    cascadesEnabled: false,
    size: 1024,
  });
  scene.shadowMap = pointLightShadowMap;
} catch (err) {
  console.error("Failed to construct point-light ShadowMap:", err);
  // Fall back to the default sun shadow map. Demo will still render
  // but won't exercise the cube-depth path.
}

// Toggle soft shadows. Batch 63 reads `shadowMap.softShadows` in the
// WebGPUEffectsBindGroup.js auto-detect path and resolves to
// pcfRadius = 1.5 cube-face texels when true. False keeps the
// Batch 57 hard-edged single-tap path bit-exact.
Sandcastle.addToggleButton("Soft shadows (5-tap PCF)", false, (checked) => {
  const sm = scene.shadowMap;
  if (Cesium.defined(sm)) {
    sm.softShadows = checked;
  }
});

Sandcastle.addToggleButton("Shadows enabled", true, (checked) => {
  viewer.shadows = checked;
});

Sandcastle.addToolbarMenu([
  {
    text: "Shadow map size: 1024",
    onselect: () => {
      if (Cesium.defined(scene.shadowMap)) {
        scene.shadowMap.size = 1024;
      }
    },
  },
  {
    text: "Shadow map size: 512",
    onselect: () => {
      if (Cesium.defined(scene.shadowMap)) {
        scene.shadowMap.size = 512;
      }
    },
  },
  {
    text: "Shadow map size: 256",
    onselect: () => {
      if (Cesium.defined(scene.shadowMap)) {
        scene.shadowMap.size = 256;
      }
    },
  },
]);
