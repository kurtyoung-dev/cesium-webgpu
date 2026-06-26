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

const statusEl = document.getElementById("status");
const featureIdEl = document.getElementById("featureIdInput");
const applyBtn = document.getElementById("applyHighlight");
const clearBtn = document.getElementById("clearHighlight");

// BENTLEY model has EXT_mesh_features + EXT_mesh_primitive_edge_visibility
// with `_FEATURE_ID_0` per-vertex — exactly the input shape Batch 48 was
// built against. The emitter flows FEATURE_ID_0 into id.g + id.b (Batch 49).
const modelUrl =
  "../../../Specs/Data/Models/glTF-2.0/StyledLines/BENTLEY_materials_line_style.gltf";

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

    // Default edge styling: yellow + 2px solid so the gating contrast
    // is visible.
    if ("edgeColor" in modelPrimitive) {
      modelPrimitive.edgeColor = new Cesium.Color(1.0, 0.8, 0.0, 1.0);
    }
    if ("edgeWidth" in modelPrimitive) {
      modelPrimitive.edgeWidth = 2;
    }
    if ("edgeLinePattern" in modelPrimitive) {
      modelPrimitive.edgeLinePattern = 0xffff;
    }

    statusEl.textContent =
      "Model loaded. Edges should be visible on all features. Highlight a feature ID to verify gating.";
  });
} catch (err) {
  console.error("Feature-ID model failed to load:", err);
  window.alert(`Error loading model: ${err}`);
  statusEl.textContent = `Failed to load: ${err}`;
}

// Set the model's per-feature color via its style. Sets the picked
// feature to red; other features keep their material colour. Edges
// through fail-open semantics should stay visible across all features.
function highlightFeature(featureId) {
  if (!Cesium.defined(modelPrimitive) || !modelPrimitive.ready) {
    return;
  }
  // Cesium.Cesium3DTileStyle works for tilesets, not bare Models, so
  // we drive the per-feature color through the model's Style API
  // instead. Falls back to a custom-shader approach if Style isn't
  // available on this Model build.
  if (typeof Cesium.Cesium3DTileStyle === "function") {
    try {
      modelPrimitive.style = new Cesium.Cesium3DTileStyle({
        color: {
          conditions: [
            [`\${featureId} === ${featureId}`, "color('red')"],
            ["true", "color('white')"],
          ],
        },
      });
      statusEl.textContent =
        `Highlighted feature ID ${featureId}. ` +
        `All edges (including non-highlighted) should remain visible.`;
      return;
    } catch (err) {
      console.warn(
        "Style API path failed; falling back to color override.",
        err,
      );
    }
  }
  // Fallback: blanket model color override. Less precise but at
  // least proves the edge feature-ID gating still tolerates a
  // body color change.
  modelPrimitive.color = Cesium.Color.RED.withAlpha(0.9);
  statusEl.textContent =
    "Style API unavailable; falling back to model.color override.";
}

function clearHighlight() {
  if (!Cesium.defined(modelPrimitive) || !modelPrimitive.ready) {
    return;
  }
  modelPrimitive.style = undefined;
  modelPrimitive.color = Cesium.Color.WHITE;
  statusEl.textContent = "Highlight cleared.";
}

applyBtn.addEventListener("click", () => {
  const id = Number(featureIdEl.value);
  if (Number.isFinite(id) && id >= 0) {
    highlightFeature(id);
  }
});
clearBtn.addEventListener("click", clearHighlight);
