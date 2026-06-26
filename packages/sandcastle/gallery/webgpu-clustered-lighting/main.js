import * as Cesium from "cesium";
import Sandcastle from "Sandcastle";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  shouldAnimate: true,
  terrain: undefined,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
});

const scene = viewer.scene;

// Globe off + dark sky: the point lights are the whole show, so we
// don't want sun-lit terrain washing them out. (Clustered lighting
// consumers are glTF models + lit primitives, not the globe terrain.)
scene.globe.show = false;
scene.skyBox.show = false;
scene.skyAtmosphere.show = false;
scene.backgroundColor = Cesium.Color.fromCssColorString("#05060a");

// Anchor everything around a flat ENU patch.
const center = Cesium.Cartesian3.fromDegrees(-75.59, 40.038, 0);
const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(center);
const localToWC = (x, y, z) =>
  Cesium.Matrix4.multiplyByPoint(
    enuTransform,
    new Cesium.Cartesian3(x, y, z),
    new Cesium.Cartesian3(),
  );

// ── Lit ground plane (a Box primitive with a Color MaterialAppearance,
// flat:false → the matColorLit shader: a clustered-lighting consumer). ──
scene.primitives.add(
  new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: Cesium.BoxGeometry.fromDimensions({
        vertexFormat:
          Cesium.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
        dimensions: new Cesium.Cartesian3(400.0, 400.0, 2.0),
      }),
      modelMatrix: Cesium.Matrix4.multiplyByTranslation(
        enuTransform,
        new Cesium.Cartesian3(0, 0, -1),
        new Cesium.Matrix4(),
      ),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: Cesium.Material.fromType("Color", {
        color: Cesium.Color.fromBytes(120, 120, 130, 255),
      }),
      flat: false,
      translucent: false,
    }),
    asynchronous: false,
  }),
);

// ── glTF models (Model PBR — the primary clustered-lighting consumer). ──
const modelUris = [
  "../../SampleData/models/GroundVehicle/GroundVehicle.glb",
  "../../SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
  "../../SampleData/models/GroundVehicle/GroundVehicle.glb",
];
const modelXs = [-22, 0, 22];
for (let i = 0; i < modelUris.length; i++) {
  const pos = localToWC(modelXs[i], 0, 0);
  viewer.entities.add({
    position: pos,
    orientation: Cesium.Transforms.headingPitchRollQuaternion(
      pos,
      new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(i * 40), 0, 0),
    ),
    model: {
      uri: modelUris[i],
      scale: 7.0,
    },
  });
}

// ── Scene lights. A ring of colored point lights orbiting just above
// the models — each one only lights the clusters it touches. ──
const lightColors = [
  Cesium.Color.fromCssColorString("#ff3b30"), // red
  Cesium.Color.fromCssColorString("#34c759"), // green
  Cesium.Color.fromCssColorString("#0a84ff"), // blue
  Cesium.Color.fromCssColorString("#ffd60a"), // amber
  Cesium.Color.fromCssColorString("#ff2d92"), // magenta
  Cesium.Color.fromCssColorString("#64d2ff"), // cyan
];
const lights = [];
const orbitRadius = 34.0;
const lightHeight = 14.0;
const lightRange = 120.0;
const lightIntensity = 600.0;
for (let i = 0; i < lightColors.length; i++) {
  const a = (i / lightColors.length) * Cesium.Math.TWO_PI;
  const light = new Cesium.PointLight({
    position: localToWC(
      Math.cos(a) * orbitRadius,
      Math.sin(a) * orbitRadius,
      lightHeight,
    ),
    color: lightColors[i],
    intensity: lightIntensity,
    range: lightRange,
  });
  scene.lights.add(light);
  lights.push({ light, phase: a });
}

// Turn the feature on.
scene.clusteredLightingEnabled = true;

// Local night so the colored lights dominate.
viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(
  "2026-06-21T04:30:00Z",
);

// Frame the scene.
viewer.camera.lookAt(
  center,
  new Cesium.HeadingPitchRange(
    Cesium.Math.toRadians(-20),
    Cesium.Math.toRadians(-16),
    105.0,
  ),
);
viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

// ── Animate the light ring (mutating PointLight.position each frame;
// the dispatcher re-runs the assignment pass when lights move). ──
let animate = true;
const startTime = performance.now();
scene.preUpdate.addEventListener(() => {
  if (!animate) {
    return;
  }
  const t = (performance.now() - startTime) * 0.0004;
  for (let i = 0; i < lights.length; i++) {
    const a = lights[i].phase + t;
    lights[i].light.position = localToWC(
      Math.cos(a) * orbitRadius,
      Math.sin(a) * orbitRadius,
      lightHeight + Math.sin(a * 2.0) * 6.0,
    );
  }
});

Sandcastle.addToggleButton("Clustered lighting", true, (checked) => {
  scene.clusteredLightingEnabled = checked;
});

Sandcastle.addToggleButton("Animate lights", true, (checked) => {
  animate = checked;
});

Sandcastle.addToolbarMenu([
  {
    text: "Lights: 6",
    onselect: () => setLightCount(6),
  },
  {
    text: "Lights: 3",
    onselect: () => setLightCount(3),
  },
  {
    text: "Lights: 1",
    onselect: () => setLightCount(1),
  },
]);

function setLightCount(n) {
  for (let i = 0; i < lights.length; i++) {
    lights[i].light.enabled = i < n;
  }
}
