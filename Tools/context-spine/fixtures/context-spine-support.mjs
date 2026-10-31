// context-spine-support.mjs — Shared hermetic fixture repository for the Context Spine specs.
// @purpose Build the compact Cesium-shaped repository (seam sources, shader registry, rulings, queues, rigs) that context-spine.spec.mjs and its context-spine-*.spec.mjs parts index and query.
// @status ACTIVE

import fs from "node:fs";
import path from "node:path";

/**
 * Populate a compact hermetic Cesium-shaped repository inside `dir` (owned by `withLaneTmp`).
 *
 * @param {string} dir
 */
export function createHermeticFixtureRepo(dir) {
  const write = (rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };

  write(
    "package.json",
    JSON.stringify(
      {
        name: "cesium-fixture",
        type: "module",
        scripts: {
          "test-model-webgpu": "node --test Tools/model.spec.mjs",
          "test-water-regimes": "node --test Tools/water.spec.mjs",
        },
      },
      null,
      2,
    ),
  );

  write(
    "Tools/visual-regression/fixtures/shader-registry-layout.json",
    JSON.stringify({
      ranges: [
        { word: "ext", start: 0, end: 20, owner: "clouds", name: "cloud-ext" },
      ],
    }),
  );

  write(
    "packages/engine/Source/Renderer/FeatureRendererKey.js",
    `const FeatureRendererKey = Object.freeze({
  MODEL: 0,
  GLOBE_SURFACE: 1,
  COUNT: 2,
});
export default FeatureRendererKey;
`,
  );

  write(
    "packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts",
    `export const ShaderDefine = Object.freeze({
  HAS_NORMALS: 1 << 0,
} as const);
export const ShaderDefineExt = Object.freeze({
  CLOUD_SHADOWMAP: extDefineBit(4),
} as const);
export const ShaderSourceId = Object.freeze({
  MODEL_PBR: 7,
} as const);
`,
  );

  write(
    "packages/engine/Source/Scene/Model.js",
    `import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
export class Model {
  update(frameState) {
    const renderer = frameState.context.getFeatureRenderer(FeatureRendererKey.MODEL);
    return renderer;
  }
}
`,
  );

  write(
    "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
    `import FeatureRendererKey from "../FeatureRendererKey.js";
import { ShaderDefineExt, ShaderSourceId } from "./WebGPUShaderDefines.js";

export class WebGPUModelRenderer {
  register(context) {
    context.registerFeatureRenderer(FeatureRendererKey.MODEL, this);
  }
  renderModel(uniformState) {
    const flagsExt = ShaderDefineExt.CLOUD_SHADOWMAP;
    const src = ShaderSourceId.MODEL_PBR;
    const nearFar = uniformState._logDepthEncodeNearFar;
    const sliceFar = uniformState.currentFrustum.far;
    const camHi = uniformState.encodedCameraPositionMCHigh;
    return { flagsExt, src, nearFar, sliceFar, camHi };
  }
}
`,
  );

  write(
    "packages/engine/Source/Shaders/WebGPU/ModelPBR.wgsl",
    `struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  encodedCameraLow: vec3<f32>,
  previousViewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

//>>ifdef CLOUD_SHADOWMAP
fn sampleCloudShadow(posHigh: vec3<f32>, posLow: vec3<f32>) -> vec4<f32> {
  let rte = translateRelativeToEye(posHigh, posLow);
  return camera.mvpRelativeToEye * rte;
}
//>>endif

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  let logDepth = 0.5;
  return vec4<f32>(logDepth);
}
`,
  );

  write(
    "packages/engine/Source/Shaders/ModelPBRFS.glsl",
    `void main() {
  gl_FragColor = vec4(1.0);
}
`,
  );

  // Planted RTE + CameraUniforms tail hazards to prove negative controls bite
  write(
    "packages/engine/Source/Shaders/WebGPU/BrokenHazard.wgsl",
    `struct BrokenCameraUniforms {
  previousViewProjection: mat4x4<f32>,
  trailingField: vec4<f32>,
}

@vertex
fn vsBroken(posHigh: vec3<f32>, posLow: vec3<f32>, position: vec3<f32>) -> @builtin(position) vec4<f32> {
  let badSum = posHigh + posLow;
  let projected = mvp * vec4<f32>(posHigh + posLow, 1.0);
  return mvp * vec4<f32>(position, 1.0) + vec4<f32>(badSum, 0.0) + projected;
}
`,
  );

  // Governance / Rulings / Queues / Blueprint / DEFERRED_WORK
  write(
    "migration_doc/MAINTAINER_RULINGS_2026-09-16.md",
    `# Maintainer rulings — 2026-09-16

## R-2026-09-16-8 — Old clean-list owner

Original owner for WebGPUModelRenderer.ts clean-list fold was cloud landing.
`,
  );

  write(
    "migration_doc/MAINTAINER_RULINGS_2026-09-17.md",
    `# Maintainer rulings — 2026-09-17

## R-2026-09-17-3 — Wave 0 clean-list fold

This amends \`R-2026-09-16-8\`: \`WebGPUModelRenderer.ts\` clean-list fold moves to wave 0.
`,
  );

  write(
    "migration_doc/QUEUE_2026-08-10_CAMPAIGN16.md",
    `# Campaign 16 Queue

| ID | Work | Size | Status |
| --- | --- | --- | --- |
| \`C16-08\` | Model PBR rewrite on \`WebGPUModelRenderer.ts\` | M | **DONE 2026-08-09** — landed cleanly. |
| \`C16-21\` | Instrument grammar scope on \`WebGPUModelRenderer.ts\` | S | **OPEN** — pending wave 0. |
`,
  );

  write(
    "migration_doc/CAMPAIGN_STATE.md",
    `# CAMPAIGN_STATE

### C12 — Celestial appearance

**Launched.** Initially thought closed.

*[**Status added 2026-09-19** by the batch that carries this line. **C12 is OPEN.** \`WebGPUModelRenderer.ts\` awaits Option C decision.]*
`,
  );

  write(
    "migration_doc/CONSOLIDATED_REMEDIATION_BLUEPRINT_2026-10-08.md",
    `# Blueprint

| Hotspot File | Findings Impacting File | Primary Epics | Systemic Vulnerability Summary |
|:---|:---:|:---:|:---|
| \`WebGPUModelRenderer.ts\` | **35** | EPIC-06, EPIC-05 | Per-slice log depth mismatch |

## EPIC-06: glTF PBR Shading & Material Cache (165 findings)

Consolidates \`WebGPUModelRenderer.ts\` and \`ModelPBR.wgsl\` material bindings.
`,
  );

  write(
    "migration_doc/DEFERRED_WORK.md",
    `# Deferred Work Inventory

### NEW-MODEL-OLDER-NOTE

\`WebGPUModelRenderer.ts\` older note recorded at Batch 900.

### NEW-MODEL-NEWER-NOTE

\`WebGPUModelRenderer.ts\` newer note recorded at Batch 1455.

### NEW-MODEL-SHIPPED-ITEM

**Status:** SHIPPED 2026-09-12 (Batch 1470) on \`WebGPUModelRenderer.ts\`.
`,
  );

  // Spatial Rigs (Probe Kit format)
  write(
    "Tools/visual-regression/rigs/arctic-svalbard.mjs",
    `export default Object.freeze({
  id: "arctic-svalbard",
  tags: ["cloud", "polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description: "Polar day stratus deck",
  camera: { lon: 20, lat: 82, height: 1500, heading: 0, pitch: 0, roll: 0 },
  clock: "2026-06-21T10:40:00Z",
  stations: [{ id: "pole", lon: 20, lat: 89.5, height: 12000 }],
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 8 },
});
`,
  );

  write(
    "Tools/visual-regression/rigs/pacific-antimeridian-water.mjs",
    `export default Object.freeze({
  id: "pacific-antimeridian-water",
  tags: ["wave-end", "globe", "water", "ssr"],
  url: "Apps/split.html",
  renderers: ["webgl", "webgpu"],
  description: "Equatorial ocean grazing sunset at antimeridian",
  camera: { lon: 179.4, lat: 1.2, height: 450, heading: 0, pitch: -0.2, roll: 0 },
  clock: "2026-03-20T06:05:00Z",
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 8 },
});
`,
  );

  write(
    "Tools/visual-regression/rigs/voxel-underground-pit.mjs",
    `export default Object.freeze({
  id: "voxel-underground-pit",
  tags: ["voxel", "c11"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description: "Subsurface excavated pit inside-camera voxel harness",
  camera: null,
  clock: null,
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 8 },
});
`,
  );
}
