// @purpose Keep the packed model IBL flag aligned with the spherical-harmonics buffer selected for binding.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/webgpu-ibl-sh-signal.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(directory, "../../packages/engine/Source");
const rendererPath = resolve(
  engineRoot,
  "Renderer/WebGPU/WebGPUModelRenderer.ts",
);

const shaderStub = {
  name: "shader-stub",
  setup(b) {
    b.onResolve({ filter: /Shaders\/.*\.js$/ }, (a) => ({
      path: a.path,
      namespace: "shader-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "shader-stub" }, () => ({
      contents: 'export default "";',
      loader: "js",
    }));
  },
};

const bundle = await build({
  entryPoints: [rendererPath],
  bundle: true,
  format: "esm",
  target: "es2022",
  write: false,
  logLevel: "silent",
  plugins: [shaderStub],
});
const rendererModuleUrl = `data:text/javascript;base64,${Buffer.from(
  bundle.outputFiles[0].text,
).toString("base64")}`;
const { getOrCreateModelIBLEntries, packLightUniforms } = await import(
  rendererModuleUrl
);

const readSource = async (relative) =>
  (await readFile(resolve(engineRoot, relative), "utf8")).replace(
    /\r\n/g,
    "\n",
  );

const sliceBetween = (source, open, close) => {
  const start = source.indexOf(open);
  assert.ok(start >= 0, `opening anchor \`${open}\` is missing`);
  const end = source.indexOf(close, start + open.length);
  assert.ok(
    end >= 0,
    `closing anchor \`${close}\` is missing after \`${open}\``,
  );
  return source.slice(start, end);
};

const webGLStageSource = await readSource(
  "Scene/Model/ImageBasedLightingPipelineStage.js",
);
const webGLProcessSource = sliceBetween(
  webGLStageSource,
  "ImageBasedLightingPipelineStage.process = function (",
  "\n\nexport default ImageBasedLightingPipelineStage;",
);

const { default: defined } = await import(
  pathToFileURL(resolve(engineRoot, "Core/defined.js")).href
);

// Execute the extracted WebGL stage so its source selection, branch define,
// and uniform declaration remain one shipping decision in this test too.
// eslint-disable-next-line no-new-func
const makeWebGLProcess = new Function(
  "combine",
  "defined",
  "ImageBasedLightingStageFS",
  "ShaderDestination",
  "SpecularEnvironmentCubeMap",
  "Cartesian2",
  `"use strict";
const ImageBasedLightingPipelineStage = {};
const scratchCartesian = {};
${webGLProcessSource}
return ImageBasedLightingPipelineStage.process;`,
);
const processWebGLIBL = makeWebGLProcess(
  (uniformMap) => uniformMap,
  defined,
  "",
  { FRAGMENT: "fragment", BOTH: "both" },
  { isSupported: () => true },
  { multiplyByScalar: () => ({}) },
);

function observeWebGLSH(imageBasedLighting, environmentMapManager) {
  const defines = [];
  const uniforms = [];
  const renderResources = {
    uniformMap: {},
    shaderBuilder: {
      addDefine(name) {
        defines.push(name);
      },
      addUniform(type, name) {
        uniforms.push({ type, name });
      },
      addFragmentLines() {},
    },
  };
  processWebGLIBL(
    renderResources,
    { imageBasedLighting, environmentMapManager },
    { context: {} },
  );
  return {
    hasCustomSH: defines.includes("CUSTOM_SPHERICAL_HARMONICS"),
    hasDiffuseIBL: defines.includes("DIFFUSE_IBL"),
    hasSHUniform: uniforms.some(
      ({ name }) => name === "model_sphericalHarmonicCoefficients[9]",
    ),
  };
}

function gpuResource(name, active) {
  return { name, active };
}

function makeHarness() {
  const defaultSHBuffer = gpuResource("pipeline-default-sh", false);
  return {
    frameState: { context: { uniformState: {} } },
    pipelineCache: {
      defaultBrdfLutView: gpuResource("default-brdf-lut-view", false),
      defaultBrdfLutSampler: gpuResource("default-brdf-lut-sampler", false),
      defaultIBLCubemapView: gpuResource("default-ibl-view", false),
      defaultIBLSampler: gpuResource("default-ibl-sampler", false),
      defaultSHBuffer,
    },
    defaultSHBuffer,
  };
}

function makeCoefficients() {
  return Array.from({ length: 9 }, (_, index) => ({
    x: index + 1,
    y: index + 2,
    z: index + 3,
  }));
}

function makeEnvironment(resources, coefficients = makeCoefficients()) {
  return {
    sphericalHarmonicCoefficients: coefficients,
    _webgpuIBLDiffuseView: resources.envDiffuseView,
    _webgpuIBLSpecularView: resources.envSpecularView,
    _webgpuIBLSampler: resources.envSampler,
    _webgpuSHBuffer: resources.envSHBuffer,
  };
}

function makeState(stateId) {
  const harness = makeHarness();
  const resources = {
    envDiffuseView: gpuResource("environment-diffuse-view", false),
    envSpecularView: gpuResource("environment-specular-view", false),
    envSampler: gpuResource("environment-sampler", false),
    envSHBuffer: gpuResource("environment-sh", true),
    userDiffuseView: gpuResource("explicit-diffuse-view", false),
    userSpecularView: gpuResource("explicit-specular-view", false),
    userSampler: gpuResource("explicit-sampler", false),
    userSHBuffer: gpuResource("explicit-sh", true),
    inactiveIBLSHBuffer: gpuResource("explicit-inactive-sh", false),
  };
  const coefficients = makeCoefficients();
  const environmentMapManager = makeEnvironment(resources);

  if (stateId === "A") {
    return {
      ...harness,
      model: {
        _imageBasedLighting: {
          sphericalHarmonicCoefficients: undefined,
          useDefaultSphericalHarmonics: false,
        },
        environmentMapManager,
      },
      expectedBuffer: resources.envSHBuffer,
      webGL: { hasCustomSH: true, hasDiffuseIBL: true, hasSHUniform: true },
    };
  }
  if (stateId === "B") {
    return {
      ...harness,
      model: {
        _imageBasedLighting: {
          sphericalHarmonicCoefficients: coefficients,
          _sphericalHarmonicCoefficients: coefficients,
          _webgpuHasSH: true,
          _webgpuSpecularView: resources.userSpecularView,
          _webgpuDiffuseView: resources.userDiffuseView,
          _webgpuSampler: resources.userSampler,
          _webgpuSHBuffer: resources.userSHBuffer,
        },
        environmentMapManager,
      },
      expectedBuffer: resources.userSHBuffer,
    };
  }
  if (stateId === "C") {
    return {
      ...harness,
      model: {
        _imageBasedLighting: {
          sphericalHarmonicCoefficients: coefficients,
          _sphericalHarmonicCoefficients: coefficients,
          _webgpuHasSH: undefined,
          _webgpuSpecularView: resources.userSpecularView,
          _webgpuDiffuseView: resources.userDiffuseView,
          _webgpuSampler: resources.userSampler,
          _webgpuSHBuffer: resources.userSHBuffer,
        },
        environmentMapManager,
      },
      expectedBuffer: resources.envSHBuffer,
      rejectedBuffer: resources.userSHBuffer,
    };
  }
  if (stateId === "D") {
    return {
      ...harness,
      model: {
        _imageBasedLighting: {
          sphericalHarmonicCoefficients: [],
          _sphericalHarmonicCoefficients: [],
          useDefaultSphericalHarmonics: false,
          _webgpuHasSH: false,
          _webgpuSpecularView: resources.userSpecularView,
          _webgpuDiffuseView: resources.userDiffuseView,
          _webgpuSampler: resources.userSampler,
          _webgpuSHBuffer: resources.inactiveIBLSHBuffer,
        },
      },
      expectedBuffer: resources.inactiveIBLSHBuffer,
      webGL: { hasCustomSH: false, hasDiffuseIBL: false, hasSHUniform: false },
    };
  }
  if (stateId === "E") {
    return {
      ...harness,
      model: {
        _imageBasedLighting: {
          sphericalHarmonicCoefficients: coefficients,
          _sphericalHarmonicCoefficients: coefficients,
          _webgpuHasSH: true,
          _webgpuSpecularView: undefined,
          _webgpuDiffuseView: undefined,
          _webgpuSampler: undefined,
          _webgpuSHBuffer: resources.userSHBuffer,
        },
      },
      expectedBuffer: harness.defaultSHBuffer,
    };
  }
  return {
    ...harness,
    model: {},
    expectedBuffer: harness.defaultSHBuffer,
  };
}

function observeWebGPU(model, pipelineCache, frameState) {
  const packed = new Float32Array(216);
  packLightUniforms(packed, frameState, model);
  const entries = getOrCreateModelIBLEntries(
    {},
    model,
    pipelineCache,
    frameState,
  );
  const shEntry = entries.find(({ binding }) => binding === 36);
  assert.ok(shEntry, "binding 36 is missing from the model IBL entries");
  assert.ok(
    typeof shEntry.resource === "object" &&
      shEntry.resource !== null &&
      "buffer" in shEntry.resource,
    "binding 36 is not a buffer binding",
  );
  return { flag: packed[15], buffer: shEntry.resource.buffer };
}

const states = [
  ["A", "environment manager projected SH"],
  ["B", "explicit published SH takes diffuse precedence"],
  ["C", "unpublished explicit SH defers to the environment manager"],
  ["D", "an empty explicit coefficient array stays inactive"],
  ["E", "an incomplete explicit IBL source uses placeholders"],
  ["F", "an unconfigured model uses placeholders"],
];

for (const [stateId, description] of states) {
  test(`state ${stateId}: ${description}`, () => {
    const {
      model,
      pipelineCache,
      frameState,
      expectedBuffer,
      rejectedBuffer,
      webGL,
    } = makeState(stateId);
    const observation = observeWebGPU(model, pipelineCache, frameState);

    assert.equal(
      observation.buffer,
      expectedBuffer,
      `state ${stateId} bound an unexpected SH buffer`,
    );
    if (rejectedBuffer !== undefined) {
      assert.notEqual(
        observation.buffer,
        rejectedBuffer,
        `state ${stateId} bound the unpublished explicit SH buffer`,
      );
    }
    assert.equal(
      typeof observation.buffer.active,
      "boolean",
      `state ${stateId} did not expose an active marker on the bound buffer`,
    );

    if (webGL !== undefined) {
      const webGLObservation = observeWebGLSH(
        model._imageBasedLighting,
        model.environmentMapManager ?? {},
      );
      assert.deepEqual(webGLObservation, webGL);
      assert.equal(
        webGLObservation.hasCustomSH,
        observation.buffer.active,
        `state ${stateId} disagrees with the WebGL resolved SH source`,
      );
      assert.equal(
        webGLObservation.hasCustomSH,
        webGLObservation.hasSHUniform,
        `state ${stateId} lets the WebGL branch and uniform disagree`,
      );
    }

    assert.equal(
      observation.flag,
      observation.buffer.active ? 1.0 : 0.0,
      `state ${stateId} packed ${observation.flag} while binding ${observation.buffer.name} (active=${observation.buffer.active})`,
    );
  });
}
