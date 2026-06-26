import * as Cesium from "cesium";
import Sandcastle from "Sandcastle";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  terrain: undefined,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
});

const scene = viewer.scene;
scene.globe.depthTestAgainstTerrain = true;

// Default 4×MSAA — this is what most CesiumJS scenes ship with and
// exactly the path Batch 61 closed.
scene.msaaSamples = 4;

// 3D Tiles photogrammetry classification target — the same Ion asset
// used by the gallery's existing "3D Tiles 1.1 Photogrammetry
// Classification" demo. Loads via `Cesium3DTileset.fromIonAssetId(...)`.
// If Ion access fails (no token configured), we fall back to a small
// local tileset to keep the demo functional.
let tileset;
try {
  // Asset 40866 = Aerometrex Denver photogrammetry; same asset used in
  // the WebGL classification gallery demo.
  tileset = await Cesium.Cesium3DTileset.fromIonAssetId(40866);
  scene.primitives.add(tileset);
} catch (err) {
  console.warn(
    "Ion tileset 40866 unavailable; falling back to a local tileset.",
    err,
  );
  // Fallback: use any locally-served 3D tileset that ships with Specs/Data.
  // The demo still demonstrates the WebGPU translucent path even if the
  // tileset is small.
  try {
    tileset = await Cesium.Cesium3DTileset.fromUrl(
      "../../../Specs/Data/Cesium3DTiles/Tilesets/Tileset/tileset.json",
    );
    scene.primitives.add(tileset);
  } catch (fallbackErr) {
    console.error("Fallback tileset also failed:", fallbackErr);
  }
}

if (Cesium.defined(tileset)) {
  tileset.style = new Cesium.Cesium3DTileStyle({
    color: "color('white')",
  });
  await viewer.zoomTo(
    tileset,
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(0),
      Cesium.Math.toRadians(-30),
      tileset.boundingSphere.radius * 2.0,
    ),
  );
}

// Translucent classification primitive: a box-shaped volume with
// half-alpha red. `classificationType: CESIUM_3D_TILE` makes it drape
// onto tileset geometry — and that's the path Batch 47 + 61 light up.
let classificationPrimitive;
if (Cesium.defined(tileset)) {
  const center = tileset.boundingSphere.center;
  const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(center);

  classificationPrimitive = scene.primitives.add(
    new Cesium.ClassificationPrimitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: Cesium.BoxGeometry.fromDimensions({
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          dimensions: new Cesium.Cartesian3(80.0, 80.0, 40.0),
        }),
        modelMatrix: Cesium.Matrix4.multiplyByTranslation(
          modelMatrix,
          new Cesium.Cartesian3(0.0, 0.0, 10.0),
          new Cesium.Matrix4(),
        ),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            new Cesium.Color(1.0, 0.2, 0.2, 0.5),
          ),
          show: new Cesium.ShowGeometryInstanceAttribute(true),
        },
        id: "classification-volume",
      }),
      classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
    }),
  );
}

// Toolbar: switch between 4×MSAA (Batch 61 path) and single-sample
// (Batch 47 path). Both should render equivalent classification.
Sandcastle.addToolbarMenu([
  {
    text: "MSAA: 4 samples (Batch 61 path)",
    onselect: () => {
      scene.msaaSamples = 4;
    },
  },
  {
    text: "MSAA: off (Batch 47 single-sample path)",
    onselect: () => {
      scene.msaaSamples = 1;
    },
  },
]);

Sandcastle.addToggleButton("Show classification volume", true, (checked) => {
  if (Cesium.defined(classificationPrimitive)) {
    classificationPrimitive.show = checked;
  }
});
