import assert from "node:assert/strict";
import test from "node:test";

import SceneMode from "../../packages/engine/Source/Scene/SceneMode.js";
import AlphaPipelineStage from "../../packages/engine/Source/Scene/Model/AlphaPipelineStage.js";
import EdgeDetectionPipelineStage from "../../packages/engine/Source/Scene/Model/EdgeDetectionPipelineStage.js";
import EdgeVisibilityPipelineStage from "../../packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js";
import FeatureIdPipelineStage from "../../packages/engine/Source/Scene/Model/FeatureIdPipelineStage.js";
import GeometryPipelineStage from "../../packages/engine/Source/Scene/Model/GeometryPipelineStage.js";
import LightingPipelineStage from "../../packages/engine/Source/Scene/Model/LightingPipelineStage.js";
import MaterialPipelineStage from "../../packages/engine/Source/Scene/Model/MaterialPipelineStage.js";
import MetadataPickingPipelineStage from "../../packages/engine/Source/Scene/Model/MetadataPickingPipelineStage.js";
import MetadataPipelineStage from "../../packages/engine/Source/Scene/Model/MetadataPipelineStage.js";
import ModelRuntimePrimitive from "../../packages/engine/Source/Scene/Model/ModelRuntimePrimitive.js";
import ModelType from "../../packages/engine/Source/Scene/Model/ModelType.js";
import PickingPipelineStage from "../../packages/engine/Source/Scene/Model/PickingPipelineStage.js";
import PrimitiveStatisticsPipelineStage from "../../packages/engine/Source/Scene/Model/PrimitiveStatisticsPipelineStage.js";

function configure(nativeRendererOnly) {
  const frameState = {
    context: { webgl2: true },
    mode: SceneMode.SCENE3D,
    scene3DOnly: false,
    verticalExaggeration: 1.0,
    edgeVisibilityRequested: false,
  };
  const runtimePrimitive = new ModelRuntimePrimitive({
    primitive: {
      attributes: [],
      featureIds: [],
      edgeVisibility: {},
    },
    node: {},
    model: {
      type: ModelType.GLTF,
      allowPicking: true,
      featureIdLabel: "featureId_0",
      hasVerticalExaggeration: true,
    },
  });

  runtimePrimitive.configurePipeline(frameState, nativeRendererOnly);
  return { frameState, stages: runtimePrimitive.pipelineStages };
}

test("native model descriptors retain shared stages without legacy pick/edge realization", () => {
  const { frameState, stages } = configure(true);

  for (const stage of [
    GeometryPipelineStage,
    MaterialPipelineStage,
    FeatureIdPipelineStage,
    MetadataPipelineStage,
    MetadataPickingPipelineStage,
    LightingPipelineStage,
    AlphaPipelineStage,
    PrimitiveStatisticsPipelineStage,
  ]) {
    assert.ok(stages.includes(stage), `${stage.name} must remain shared`);
  }

  assert.equal(stages.includes(PickingPipelineStage), false);
  assert.equal(stages.includes(EdgeVisibilityPipelineStage), false);
  assert.equal(stages.includes(EdgeDetectionPipelineStage), false);
  assert.equal(frameState.edgeVisibilityRequested, true);
});

test("legacy model realization keeps picking and extension-edge stages", () => {
  const { frameState, stages } = configure(false);

  assert.equal(stages.includes(PickingPipelineStage), true);
  assert.equal(stages.includes(EdgeVisibilityPipelineStage), true);
  assert.equal(stages.includes(EdgeDetectionPipelineStage), true);
  assert.equal(frameState.edgeVisibilityRequested, true);
});

test("omitting the descriptor mode preserves the legacy default", () => {
  const { stages } = configure(undefined);

  assert.equal(stages.includes(PickingPipelineStage), true);
  assert.equal(stages.includes(EdgeVisibilityPipelineStage), true);
});
