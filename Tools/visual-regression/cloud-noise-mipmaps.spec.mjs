// @purpose Pins WebGPUCloudNoiseResources + CloudNoiseMipmap.wgsl mip-chain agreement, with a loud guard on the halve-to-1 loop's integer precondition.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const resourcePath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudNoiseResources.ts",
);
const shaderPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Compute/CloudNoiseMipmap.wgsl",
);
const resourceSource = fs.readFileSync(resourcePath, "utf8");
const shaderSource = fs.readFileSync(shaderPath, "utf8");

function mipDimensions(baseResolution) {
  // Guard the condition-less loop below: only a positive integer base halves
  // down to exactly 1. NaN/Infinity/non-integer inputs would never hit the
  // `resolution === 1` exit and would spin forever, so fail loud instead.
  if (!Number.isInteger(baseResolution) || baseResolution < 1) {
    throw new Error(
      `mipDimensions requires a positive integer base resolution, got ${baseResolution}`,
    );
  }
  const dimensions = [];
  for (
    let resolution = baseResolution;
    ;
    resolution = Math.max(1, Math.floor(resolution / 2))
  ) {
    dimensions.push(resolution);
    if (resolution === 1) {
      return dimensions;
    }
  }
}

function mipChainVoxelCount(baseResolution) {
  return mipDimensions(baseResolution).reduce(
    (sum, resolution) => sum + resolution ** 3,
    0,
  );
}

function averageEight(voxels) {
  const result = [0.0, 0.0, 0.0, 0.0];
  for (const voxel of voxels) {
    for (let channel = 0; channel < 4; channel++) {
      result[channel] += voxel[channel] / 8.0;
    }
  }
  return result;
}

test("3D mip shader is a pure validated eight-voxel box downsample", async () => {
  assert.match(
    shaderSource,
    /@group\(0\)\s*@binding\(0\)\s*var sourceMip:\s*texture_3d<f32>/,
  );
  assert.match(
    shaderSource,
    /@group\(0\)\s*@binding\(1\)\s*var destinationMip:\s*texture_storage_3d<rgba8unorm,\s*write>/,
  );
  assert.match(shaderSource, /@compute\s+@workgroup_size\(4,\s*4,\s*4\)/);
  assert.match(shaderSource, /fn downsampleCloudNoiseMip\(/);
  assert.match(shaderSource, /textureDimensions\(sourceMip\)/);
  assert.match(shaderSource, /textureDimensions\(destinationMip\)/);
  assert.match(shaderSource, /sourceBase\s*=\s*gid\s*\*\s*2u/);
  assert.match(shaderSource, /textureLoad\(\s*sourceMip/);
  assert.match(shaderSource, /textureStore\(\s*destinationMip/);
  assert.match(shaderSource, /sum\s*\*\s*\(1\.0\s*\/\s*8\.0\)/);
  assert.doesNotMatch(
    shaderSource,
    /var\s+\w+\s*:\s*sampler|@binding\(2\)|var<uniform>/,
  );

  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() => naga.validate_wgsl(shaderSource));
});

test("all cloud-noise textures allocate and expose complete mip chains", () => {
  assert.match(
    resourceSource,
    /import CloudNoiseMipmapSource from .*CloudNoiseMipmap\.js/,
  );
  assert.match(
    resourceSource,
    /shapeMipLevelCount:\s*number[\s\S]*detailMipLevelCount:\s*number/,
  );
  assert.match(
    resourceSource,
    /Math\.floor\(Math\.log2\(Math\.max\(1,\s*resolution\)\)\)\s*\+\s*1/,
  );

  const allocationSection = resourceSource.slice(
    resourceSource.indexOf("export function buildCloudNoiseResources("),
    resourceSource.indexOf("const module = device.createShaderModule"),
  );
  assert.match(
    allocationSection,
    /CloudNoise_Shape[\s\S]*mipLevelCount:\s*shapeMipLevelCount/,
  );
  assert.match(
    allocationSection,
    /CloudNoise_Detail[\s\S]*mipLevelCount:\s*detailMipLevelCount/,
  );
  assert.match(
    allocationSection,
    /CloudNoise_Shape_StorageView[\s\S]*baseMipLevel:\s*0[\s\S]*mipLevelCount:\s*1/,
  );
  assert.match(
    allocationSection,
    /CloudNoise_Detail_StorageView[\s\S]*baseMipLevel:\s*0[\s\S]*mipLevelCount:\s*1/,
  );
  assert.match(
    allocationSection,
    /CloudNoise_Shape_SampleView[\s\S]*baseMipLevel:\s*0[\s\S]*mipLevelCount:\s*shapeMipLevelCount/,
  );
  assert.match(
    allocationSection,
    /CloudNoise_Detail_SampleView[\s\S]*baseMipLevel:\s*0[\s\S]*mipLevelCount:\s*detailMipLevelCount/,
  );

  const optionalPwSection = resourceSource.slice(
    resourceSource.indexOf("if (perlinWorley)"),
    resourceSource.indexOf("// One-shot bake"),
  );
  assert.match(
    optionalPwSection,
    /CloudNoise_ShapePW[\s\S]*mipLevelCount:\s*shapeMipLevelCount/,
  );
  assert.match(
    optionalPwSection,
    /CloudNoise_ShapePW_StorageView[\s\S]*baseMipLevel:\s*0[\s\S]*mipLevelCount:\s*1/,
  );
  assert.match(
    optionalPwSection,
    /CloudNoise_ShapePW_SampleView[\s\S]*baseMipLevel:\s*0[\s\S]*mipLevelCount:\s*shapeMipLevelCount/,
  );

  assert.match(
    resourceSource,
    /mipmapFilter:\s*"linear"[\s\S]*addressModeU:\s*"repeat"/,
  );
  assert.match(
    resourceSource,
    /shapeMipLevelCount,\s*[\r\n]+\s*detailMipLevelCount,/,
  );
});

test("one encoder preserves level zero then emits explicit per-mip passes", () => {
  const helper = resourceSource.slice(
    resourceSource.indexOf("function encodeCloudNoiseMipChain("),
    resourceSource.indexOf("/**\n * Allocate the two 3D textures"),
  );
  assert.match(
    helper,
    /for\s*\(\s*let mipLevel\s*=\s*1;\s*mipLevel\s*<\s*mipLevelCount/,
  );
  assert.match(
    helper,
    /baseMipLevel:\s*mipLevel\s*-\s*1[\s\S]*mipLevelCount:\s*1/,
  );
  assert.match(helper, /baseMipLevel:\s*mipLevel,[\s\S]*mipLevelCount:\s*1/);
  assert.match(
    helper,
    /encoder\.beginComputePass\([\s\S]*pass\.dispatchWorkgroups\([\s\S]*pass\.end\(\)/,
  );
  assert.match(
    helper,
    /Math\.floor\(baseResolution\s*\/\s*2\s*\*\*\s*mipLevel\)/,
  );

  const oneShot = resourceSource.slice(
    resourceSource.indexOf(
      'const encoder = device.createCommandEncoder({ label: "CloudNoise_Bake" })',
    ),
    resourceSource.indexOf("const sampler3d = device.createSampler"),
  );
  // The established level-0 entry points and dispatch budgets remain first.
  assert.match(
    oneShot,
    /pass\.setPipeline\(shapePipeline\)[\s\S]*dispatchWorkgroups\(wgShape,\s*wgShape,\s*wgShape\)/,
  );
  assert.match(
    oneShot,
    /pass\.setPipeline\(detailPipeline\)[\s\S]*dispatchWorkgroups\(wgDetail,\s*wgDetail,\s*wgDetail\)/,
  );
  assert.match(
    oneShot,
    /shapePWPipeline[\s\S]*pass\.setPipeline\(shapePWPipeline\)/,
  );

  const basePassEnd = oneShot.indexOf("pass.end();");
  const firstMipDispatch = oneShot.indexOf("encodeCloudNoiseMipChain(");
  const submit = oneShot.indexOf("device.queue.submit([encoder.finish()])");
  assert.ok(basePassEnd >= 0);
  assert.ok(firstMipDispatch > basePassEnd);
  assert.ok(submit > firstMipDispatch);
  assert.equal(
    oneShot.match(/encodeCloudNoiseMipChain\(/g)?.length,
    3,
    "shape, detail, and optional PW must each generate their chain",
  );
  assert.match(
    oneShot,
    /if \(shapePWTexture\)\s*\{[\s\S]*encodeCloudNoiseMipChain\(/,
  );
});

test("full-chain math is bounded and the kernel preserves box means", () => {
  assert.deepEqual(mipDimensions(128), [128, 64, 32, 16, 8, 4, 2, 1]);
  assert.deepEqual(mipDimensions(32), [32, 16, 8, 4, 2, 1]);
  assert.deepEqual(mipDimensions(1), [1]);

  const shapeVoxelRatio = mipChainVoxelCount(128) / 128 ** 3;
  const detailVoxelRatio = mipChainVoxelCount(32) / 32 ** 3;
  assert.ok(shapeVoxelRatio > 1.14 && shapeVoxelRatio < 8.0 / 7.0);
  assert.ok(detailVoxelRatio > 1.14 && detailVoxelRatio < 8.0 / 7.0);

  const voxels = [
    [0.0, 0.1, 0.2, 1.0],
    [1.0, 0.2, 0.3, 1.0],
    [0.2, 0.3, 0.4, 1.0],
    [0.8, 0.4, 0.5, 1.0],
    [0.4, 0.5, 0.6, 1.0],
    [0.6, 0.6, 0.7, 1.0],
    [0.25, 0.7, 0.8, 1.0],
    [0.75, 0.8, 0.9, 1.0],
  ];
  const average = averageEight(voxels);
  for (let channel = 0; channel < 4; channel++) {
    const reference =
      voxels.reduce((sum, voxel) => sum + voxel[channel], 0.0) / 8.0;
    assert.ok(Math.abs(average[channel] - reference) < 1e-12);
  }
  assert.equal(average[3], 1.0, "opaque detail alpha remains opaque");

  const constant = averageEight(
    Array.from({ length: 8 }, () => [0.37, 0.51, 0.83, 0.25]),
  );
  for (const [channel, expected] of [0.37, 0.51, 0.83, 0.25].entries()) {
    assert.ok(Math.abs(constant[channel] - expected) < 1e-12);
  }
});
