import * as Cesium from "cesium";

// Force WebGPU. The Batch 48 inline edge stage lives in ModelPBRComplete.wgsl,
// so this demo only makes sense on the WebGPU backend.
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

// Local glTF asset that uses EXT_mesh_primitive_edge_visibility.
// Simpler asset chosen for this demo so it isolates the edge stage;
// the per-feature variant (BENTLEY_materials_line_style.gltf) is
// exercised separately in `WebGPU Edge Feature ID.html`. Both work
// since BUG-F2 was fixed in Batch 66 (ShaderFunction.js empty-body
// throw lifted to allow legitimate empty `initializeMetadata`).
const modelUrl =
  "../../../Specs/Data/Models/glTF-2.0/EdgeVisibility/glTF-Binary/EdgeVisibilityMaterial.glb";

const origin = Cesium.Cartesian3.fromDegrees(0.0, 0.0, 0.0);
const hpr = new Cesium.HeadingPitchRoll(0.0, 0.0, 0.0);
const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(origin, hpr);

let modelPrimitive;
try {
  modelPrimitive = await Cesium.Model.fromGltfAsync({
    url: modelUrl,
    modelMatrix: modelMatrix,
  });
  viewer.scene.primitives.add(modelPrimitive);

  modelPrimitive.readyEvent.addEventListener(() => {
    const camera = viewer.camera;
    const r =
      2.0 * Math.max(modelPrimitive.boundingSphere.radius, camera.frustum.near);
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = r * 0.5;

    camera.lookAt(
      modelPrimitive.boundingSphere.center,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(230.0),
        Cesium.Math.toRadians(-20.0),
        r * 2.0,
      ),
    );
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    applyEdgeProperties();
  });
} catch (err) {
  console.error("Edge-visibility model failed to load:", err);
  window.alert(`Error loading model: ${err}`);
}

// Edge-property knobs. The Model API surfaces edge styling per-primitive at
// load time (from EXT_mesh_primitive_edge_visibility), but the runtime
// overrides go through `model.edgeColor` / `model.edgeWidth` /
// `model.edgeLinePattern` once the model is ready. The Batch 48 inline
// stage reads these values per-frame from the EffectsBindGroup UBO.
const edgeColorEl = document.getElementById("edgeColor");
const lineWidthEl = document.getElementById("lineWidth");
const lineWidthLabel = document.getElementById("lineWidthLabel");
const linePatternEl = document.getElementById("linePattern");

function hexToCesiumColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255.0;
  const g = parseInt(hex.slice(3, 5), 16) / 255.0;
  const b = parseInt(hex.slice(5, 7), 16) / 255.0;
  return new Cesium.Color(r, g, b, 1.0);
}

function applyEdgeProperties() {
  if (!Cesium.defined(modelPrimitive) || !modelPrimitive.ready) {
    return;
  }
  const color = hexToCesiumColor(edgeColorEl.value);
  const width = Number(lineWidthEl.value);
  const pattern = Number(linePatternEl.value);

  // The Model class exposes runtime edge-style slots so apps can override
  // the values authored in EXT_mesh_primitive_edge_visibility. Guarded
  // because pre-Batch-46 builds only had `edgeColor`.
  if ("edgeColor" in modelPrimitive) {
    modelPrimitive.edgeColor = color;
  }
  if ("edgeWidth" in modelPrimitive) {
    modelPrimitive.edgeWidth = width;
  }
  if ("edgeLinePattern" in modelPrimitive) {
    modelPrimitive.edgeLinePattern = pattern;
  }
}

edgeColorEl.addEventListener("input", applyEdgeProperties);
lineWidthEl.addEventListener("input", () => {
  lineWidthLabel.textContent = lineWidthEl.value;
  applyEdgeProperties();
});
linePatternEl.addEventListener("change", applyEdgeProperties);
