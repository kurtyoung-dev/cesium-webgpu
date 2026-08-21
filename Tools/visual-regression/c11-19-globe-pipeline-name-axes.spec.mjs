// C11-19 globe pipeline descriptor-name axis contract.
// @purpose Execute the real globe descriptor builder and keep its diagnostic name complete without changing non-name behavior.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/c11-19-globe-pipeline-name-axes.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";
import { transform } from "esbuild";

const pipelineSourceUrl = new URL(
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
  import.meta.url,
);
const pickHelperSourceUrl = new URL(
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUPickCommandHelpers.ts",
  import.meta.url,
);

const DebugFragmentMode = Object.freeze({
  NONE: 0,
  TRIANGULATION: 1,
  LOD: 2,
  NORMAL: 3,
});

let buildPipelineDescriptor;
let buildNameNeutralDescriptor;
let buildGlobePickPipelineDescriptor;
let buildPickPipelineDescriptor;
let selectPickPipeline;

function mustReplaceOnce(source, beforeText, afterText, purpose) {
  const occurrences = source.split(beforeText).length - 1;
  assert.equal(occurrences, 1, `${purpose}: expected one exact source match`);
  const result = source.replace(beforeText, afterText);
  assert.notEqual(result, source, `${purpose}: replacement must change source`);
  return result;
}

function extractBalancedFunction(
  source,
  signature,
  bodyOpening = "): WebGPURenderPipelineDescriptor {",
) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing function signature: ${signature}`);
  const declarationEnd = source.indexOf(bodyOpening, start + signature.length);
  assert.notEqual(declarationEnd, -1, `missing function body: ${signature}`);
  const open = declarationEnd + bodyOpening.length - 1;

  let depth = 0;
  let quote;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === "\\") {
        index++;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") {
      depth++;
    } else if (character === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  assert.fail(`unterminated function body: ${signature}`);
}

async function compileDescriptorBuilders(source, pickHelperSource) {
  const functionSource = extractBalancedFunction(
    source,
    "export function buildPipelineDescriptor(",
  );
  const globePickFunctionSource = extractBalancedFunction(
    source,
    "function buildGlobePickPipelineDescriptor(",
  );
  const pickFunctionSource = extractBalancedFunction(
    pickHelperSource,
    "export function buildPickPipelineDescriptor(",
  );
  const selectPickFunctionSource = extractBalancedFunction(
    source,
    "export function selectPickPipeline(",
    "): GPURenderPipeline | null {",
  );
  const harness = `
const DebugFragmentMode = { NONE: 0, TRIANGULATION: 1, LOD: 2, NORMAL: 3 };
const ShaderDefine = {
  GEODETIC_NORMAL: 1,
  LOG_DEPTH: 2,
  GLOBE_IMAGERY_REDUCED: 4,
  CAPTURE_MODE: 8,
};
function getProductionShaderModuleHelper(host, defines) {
  return host._moduleFor("production", defines);
}
function getDebugFragmentShaderModuleHelper(host, defines) {
  return host._moduleFor("debug", defines);
}
function getClipDistancesShaderModuleHelper(host, defines) {
  return host._moduleFor("clip", defines);
}
const buildGlobePipelineCacheKey = (options) => JSON.stringify(options);
const descriptorToGPU = (d) => d;
${functionSource}
${pickFunctionSource}
${globePickFunctionSource}
${selectPickFunctionSource.replace("export function", "function")}
export { buildGlobePickPipelineDescriptor, selectPickPipeline };
`;
  const { code } = await transform(harness, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", code)(module, module.exports);
  assert.equal(
    typeof module.exports.buildPipelineDescriptor,
    "function",
    "the extracted descriptor builder must be executable",
  );
  assert.equal(
    typeof module.exports.buildGlobePickPipelineDescriptor,
    "function",
    "the extracted globe pick derivation must be executable",
  );
  assert.equal(
    typeof module.exports.buildPickPipelineDescriptor,
    "function",
    "the extracted shared pick derivation must be executable",
  );
  assert.equal(
    typeof module.exports.selectPickPipeline,
    "function",
    "the extracted pick selection entry point must be executable",
  );
  return module.exports;
}

before(async () => {
  const [source, pickHelperSource] = await Promise.all([
    readFile(pipelineSourceUrl, "utf8"),
    readFile(pickHelperSourceUrl, "utf8"),
  ]);
  const live = await compileDescriptorBuilders(source, pickHelperSource);
  buildPipelineDescriptor = live.buildPipelineDescriptor;
  buildGlobePickPipelineDescriptor = live.buildGlobePickPipelineDescriptor;
  buildPickPipelineDescriptor = live.buildPickPipelineDescriptor;
  selectPickPipeline = live.selectPickPipeline;

  const liveName =
    "    name: `Globe terrain (${quantLabel}, ${normLabel}, ${blendLabel}${debugLabel}${cdLabel}${dobLabel}${dofLabel}${tbfLabel}${ncLabel}${imgLabel}${capLabel}${oceanLabel}${ldLabel}${strideLabel}${mercatorLabel}${geodeticLabel}${sampleLabel})`,";
  const nameNeutral =
    "    name: `Globe terrain (${quantLabel}, ${normLabel}, ${blendLabel}${debugLabel}${cdLabel}${dobLabel}${dofLabel}${tbfLabel}${ncLabel}${imgLabel}${capLabel}${oceanLabel}${ldLabel})`,";
  const neutralSource = mustReplaceOnce(
    source,
    liveName,
    nameNeutral,
    "name-neutral descriptor baseline",
  );
  const neutral = await compileDescriptorBuilders(
    neutralSource,
    pickHelperSource,
  );
  buildNameNeutralDescriptor = neutral.buildPipelineDescriptor;
});

function makeHost({
  sampleCount = 1,
  logDepth = false,
  imageryReduced = false,
  enhancedOcean = false,
} = {}) {
  const modules = new Map();
  return {
    _canvasFormat: "bgra8unorm",
    _pipelineLayout: Object.freeze({ kind: "globe-layout" }),
    _sampleCount: sampleCount,
    _pickFormat: "rgba8unorm",
    _logDepthEnabled: logDepth,
    _imageryReduced: imageryReduced,
    _enhancedOceanEnabled: enhancedOcean,
    _moduleFor(kind, defines) {
      const key = `${kind}:${defines}`;
      if (!modules.has(key)) {
        modules.set(key, Object.freeze({ kind, defines }));
      }
      return modules.get(key);
    },
  };
}

function buildWith(builder, host, state = {}) {
  return builder(
    host,
    state.isQuantized ?? false,
    state.hasNormals ?? false,
    state.hasWebMercatorT ?? false,
    state.isBlend ?? false,
    state.strideBytes ?? 24,
    state.debugFragmentMode ?? DebugFragmentMode.NONE,
    state.useClipDistances ?? false,
    state.hasGeodeticSurfaceNormals ?? false,
    state.disableCulling ?? false,
    state.depthOnlyBackFace ?? false,
    state.translucentBackFace ?? false,
    state.captureFaceFormat,
    state.depthOnlyFrontFace ?? false,
    state.logDepthOverride,
  );
}

function withoutDiagnosticName(descriptor) {
  return { ...descriptor, name: "<diagnostic-name>" };
}

test("the executed builder names every residual globe descriptor axis", () => {
  const host = makeHost();
  const base = buildWith(buildPipelineDescriptor, host);
  const wide = buildWith(buildPipelineDescriptor, host, { strideBytes: 52 });
  assert.match(base.name, /, stride=24/u);
  assert.match(wide.name, /, stride=52/u);
  assert.notEqual(base.name, wide.name);

  const geographic = buildWith(buildPipelineDescriptor, host, {
    strideBytes: 36,
  });
  const mercator = buildWith(buildPipelineDescriptor, host, {
    strideBytes: 36,
    hasWebMercatorT: true,
  });
  assert.doesNotMatch(geographic.name, /, webMercatorT/u);
  assert.match(mercator.name, /, webMercatorT/u);
  assert.notEqual(geographic.name, mercator.name);

  const ellipsoid = buildWith(buildPipelineDescriptor, host, {
    strideBytes: 48,
  });
  const geodetic = buildWith(buildPipelineDescriptor, host, {
    strideBytes: 48,
    hasGeodeticSurfaceNormals: true,
  });
  assert.doesNotMatch(ellipsoid.name, /, geodeticNormals/u);
  assert.match(geodetic.name, /, geodeticNormals/u);
  assert.notEqual(ellipsoid.name, geodetic.name);

  const singleSample = buildWith(buildPipelineDescriptor, makeHost());
  const fourSample = buildWith(
    buildPipelineDescriptor,
    makeHost({ sampleCount: 4 }),
  );
  assert.match(singleSample.name, /, samples=1\)/u);
  assert.match(fourSample.name, /, samples=4\)/u);
  assert.notEqual(singleSample.name, fourSample.name);
});

test("names report effective clamped stride and capture sample count", () => {
  const host = makeHost({ sampleCount: 4 });
  const clamped = buildWith(buildPipelineDescriptor, host, { strideBytes: 4 });
  const minimum = buildWith(buildPipelineDescriptor, host, {
    strideBytes: 24,
  });
  assert.equal(clamped.vertex.buffers[0].arrayStride, 24);
  assert.equal(clamped.name, minimum.name);

  const captureAtFour = buildWith(buildPipelineDescriptor, host, {
    captureFaceFormat: "rgba8unorm",
  });
  const captureAtOne = buildWith(buildPipelineDescriptor, makeHost(), {
    captureFaceFormat: "rgba8unorm",
  });
  assert.equal(captureAtFour.multisample, undefined);
  assert.match(captureAtFour.name, /, samples=1\)/u);
  assert.equal(captureAtFour.name, captureAtOne.name);
});

test("the executed globe pick derivation names its forced single sample", () => {
  const host = makeHost({ sampleCount: 4 });
  const color = buildWith(buildPipelineDescriptor, host);
  const pick = buildGlobePickPipelineDescriptor(host, color);
  assert.match(color.name, /, samples=4\)$/u);
  assert.match(pick.name, /, samples=1\) pick$/u);
  assert.equal(pick.multisample, undefined);

  const oldNamePick = buildPickPipelineDescriptor(
    color,
    "fragmentPickMain",
    host._pickFormat,
    {
      name: `${color.name} pick`,
      forceDepthWriteEnabled: true,
    },
  );
  assert.deepEqual(
    withoutDiagnosticName(pick),
    withoutDiagnosticName(oldNamePick),
    "the derived pick edit must change only its diagnostic name",
  );
  const priorError = console.error;
  const reported = [];
  console.error = (...parts) => {
    reported.push(parts.join(" "));
  };
  let fallback;
  try {
    fallback = buildGlobePickPipelineDescriptor(host, {
      ...color,
      name: "Globe terrain (missing sample marker)",
    });
  } finally {
    console.error = priorError;
  }
  assert.equal(
    fallback.name,
    "Globe terrain (missing sample marker) pick",
    "a marker-less name must fall through unmodified, not throw",
  );
  assert.equal(reported.length, 1, "the missing marker must be reported");
  assert.match(reported[0], /missing its effective sample suffix/u);
});

test("selectPickPipeline routes through the single-sample derivation", () => {
  const host = makeHost({ sampleCount: 4 });
  host._pipelineCache = new Map();
  const created = [];
  host._device = {
    createRenderPipeline(descriptor) {
      created.push(descriptor);
      return Object.freeze({ kind: "pipeline" });
    },
  };
  const pipeline = selectPickPipeline(host, false, false, false, 24);
  assert.notEqual(pipeline, null, "the fake device must yield a pipeline");
  assert.equal(host._pipelineCache.size, 1);
  const [entry] = host._pipelineCache.values();
  assert.match(
    entry.descriptor.name,
    /, samples=1\) pick$/u,
    "the cached pick descriptor must carry the derived single-sample name",
  );
  assert.equal(entry.pipeline, pipeline);
  assert.equal(created.length, 1);
});

test("the edit changes descriptor names and no non-name behavior", () => {
  const states = [
    {},
    { strideBytes: 52 },
    { hasWebMercatorT: true, strideBytes: 36 },
    { hasGeodeticSurfaceNormals: true, strideBytes: 48 },
    { isQuantized: true, hasNormals: true, hasWebMercatorT: true },
    { captureFaceFormat: "rgba16float" },
  ];
  const hostStates = [
    {},
    { sampleCount: 4 },
    { logDepth: true },
    { imageryReduced: true },
  ];
  let changedNames = 0;
  for (const hostState of hostStates) {
    for (const state of states) {
      const host = makeHost(hostState);
      const live = buildWith(buildPipelineDescriptor, host, state);
      const neutral = buildWith(buildNameNeutralDescriptor, host, state);
      assert.deepEqual(
        withoutDiagnosticName(live),
        withoutDiagnosticName(neutral),
        `non-name descriptor drift: host=${JSON.stringify(hostState)} state=${JSON.stringify(state)}`,
      );
      if (live.name !== neutral.name) {
        changedNames++;
      }
    }
  }
  assert.equal(changedNames, hostStates.length * states.length);
});
