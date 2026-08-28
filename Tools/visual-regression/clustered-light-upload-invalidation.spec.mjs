import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);

enableEngineTsResolution();

const rendererUrl = pathToFileURL(
  resolve(engineWebGPU, "WebGPUClusterAssignRenderer.ts"),
).href;
const shaderSpecifiers = new Set([
  "../../Shaders/WebGPU/Compute/ClusterAssign.js",
  "../../Shaders/WebGPU/Compute/ClusterBounds.js",
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (shaderSpecifiers.has(specifier)) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export%20default%20%22%22%3B",
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === rendererUrl) {
      return {
        format: "module",
        shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), {
          mode: "transform",
          sourceUrl: url,
        }),
      };
    }
    return nextLoad(url, context);
  },
});

const {
  CLUSTERED_LIGHT_FLOATS,
  WebGPUClusterAssignRenderer,
  packedClusteredLightsChanged,
} = await import(rendererUrl);

const PACKED_SLOT_NAMES = [
  "posOrDir.x",
  "posOrDir.y",
  "posOrDir.z",
  "type",
  "color.r",
  "color.g",
  "color.b",
  "intensity",
  "range",
  "constantAtt",
  "linearAtt",
  "quadraticAtt",
  "innerConeAngle",
  "outerConeAngle",
  "pad[14]",
  "pad[15]",
  "spotDir.x",
  "spotDir.y",
  "spotDir.z",
  "pad[19]",
];

const PAD_SLOTS = [14, 15, 19];

function makePackedRecord() {
  const packed = new Float32Array(CLUSTERED_LIGHT_FLOATS);
  for (let slot = 0; slot < packed.length; slot++) {
    packed[slot] = (slot + 1) / 8;
  }
  for (const slot of PAD_SLOTS) {
    packed[slot] = 0;
  }
  return packed;
}

function makeLight() {
  return {
    type: 1,
    posOrDir: { x: 1, y: 2, z: 3 },
    color: { r: 0.25, g: 0.5, b: 0.75 },
    intensity: 4,
    range: 100,
    constantAtt: 1,
    linearAtt: 0.2,
    quadraticAtt: 0.03,
    innerConeAngle: 0.4,
    outerConeAngle: 0.7,
    spotDir: { x: 0, y: -1, z: 0 },
  };
}

function installWebGPUConstants() {
  const previousShaderStage = globalThis.GPUShaderStage;
  const previousBufferUsage = globalThis.GPUBufferUsage;
  globalThis.GPUShaderStage = { COMPUTE: 1 };
  globalThis.GPUBufferUsage = {
    STORAGE: 1,
    COPY_DST: 2,
    UNIFORM: 4,
    COPY_SRC: 8,
  };

  return () => {
    if (previousShaderStage === undefined) {
      delete globalThis.GPUShaderStage;
    } else {
      globalThis.GPUShaderStage = previousShaderStage;
    }
    if (previousBufferUsage === undefined) {
      delete globalThis.GPUBufferUsage;
    } else {
      globalThis.GPUBufferUsage = previousBufferUsage;
    }
  };
}

function createStubbedGPU() {
  const writes = [];
  const dispatches = [];
  const device = {
    queue: {
      writeBuffer(buffer, bufferOffset, data, dataOffset, size) {
        writes.push({ buffer, bufferOffset, data, dataOffset, size });
      },
    },
    createShaderModule() {
      return {};
    },
    createBindGroupLayout() {
      return {};
    },
    createPipelineLayout() {
      return {};
    },
    createComputePipeline() {
      return {};
    },
    createBuffer(descriptor) {
      return {
        label: descriptor.label,
        destroy() {},
      };
    },
    createBindGroup() {
      return {};
    },
  };
  const encoder = {
    beginComputePass() {
      return {
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups(...groups) {
          dispatches.push(groups);
        },
        end() {},
      };
    },
  };
  return { device, dispatches, encoder, writes };
}

test("packed-light field coverage matrix invalidates every stored slot", () => {
  assert.equal(CLUSTERED_LIGHT_FLOATS, 20);
  assert.equal(PACKED_SLOT_NAMES.length, CLUSTERED_LIGHT_FLOATS);

  const baseline = makePackedRecord();
  const results = PACKED_SLOT_NAMES.map((name, slot) => {
    const mutated = baseline.slice();
    mutated[slot] += 0.5;
    return {
      name,
      slot,
      changed: packedClusteredLightsChanged(baseline, 1, mutated, 1),
    };
  });

  assert.deepEqual(
    results.filter((result) => !result.changed),
    [],
    `slots reported unchanged: ${JSON.stringify(results)}`,
  );
  for (const slot of PAD_SLOTS) {
    assert.equal(
      results[slot].changed,
      true,
      `${results[slot].name} is significant`,
    );
  }
});

test("identical packed lights report unchanged on the second comparison", () => {
  const current = makePackedRecord();
  const retained = new Float32Array(CLUSTERED_LIGHT_FLOATS);
  let retainedCount = 0;

  assert.equal(
    packedClusteredLightsChanged(retained, retainedCount, current, 1),
    true,
  );
  retained.set(current);
  retainedCount = 1;
  assert.equal(
    packedClusteredLightsChanged(retained, retainedCount, current, 1),
    false,
  );
});

test("light-count changes report changed in both directions", () => {
  const record = makePackedRecord();
  const retainedCapacity = new Float32Array(CLUSTERED_LIGHT_FLOATS * 2);
  retainedCapacity.set(record, 0);
  retainedCapacity.set(record, CLUSTERED_LIGHT_FLOATS);

  assert.equal(
    packedClusteredLightsChanged(retainedCapacity, 1, retainedCapacity, 2),
    true,
  );
  assert.equal(
    packedClusteredLightsChanged(retainedCapacity, 2, retainedCapacity, 1),
    true,
  );
});

test("renderer uploads a color-only change and skips the next identical frame", () => {
  const restoreWebGPUConstants = installWebGPUConstants();
  const { device, dispatches, encoder, writes } = createStubbedGPU();
  const clusterAABBs = { label: "cluster AABBs" };
  let renderer;

  try {
    renderer = new WebGPUClusterAssignRenderer(device);
    const firstLight = makeLight();
    const colorChangedLight = {
      ...firstLight,
      color: { ...firstLight.color, g: 0.625 },
    };

    assert.equal(renderer.dispatch(encoder, clusterAABBs, [firstLight]), true);
    assert.equal(
      renderer.dispatch(encoder, clusterAABBs, [colorChangedLight]),
      true,
    );
    assert.equal(
      writes.filter((write) => write.buffer.label === "ClusterAssign lights")
        .length,
      2,
    );
    assert.equal(dispatches.length, 2);

    assert.equal(
      renderer.dispatch(encoder, clusterAABBs, [colorChangedLight]),
      false,
    );
    assert.equal(
      writes.filter((write) => write.buffer.label === "ClusterAssign lights")
        .length,
      2,
    );
    assert.equal(dispatches.length, 2);
  } finally {
    renderer?.destroy();
    restoreWebGPUConstants();
  }
});
