/**
 * Pure-Node coverage for mutable WebGPU model-instancing provenance and
 * submit-safe buffer replacement.
 *
 * Run:
 * npm run test-model-webgpu
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { setImmediate } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(HERE, "../../../Source");
const INSTANCING_SOURCE_PATH = resolve(
  ENGINE_SOURCE,
  "Renderer/WebGPU/WebGPUModelInstancing.js",
);

globalThis.GPUBufferUsage = globalThis.GPUBufferUsage ?? {
  STORAGE: 0x01,
  COPY_DST: 0x02,
};

const MODULE_URL =
  process.env.CESIUM_WEBGPU_MODEL_INSTANCING_MODULE ??
  pathToFileURL(INSTANCING_SOURCE_PATH).href;

const { ensureInstancingResources, destroyInstancingResources } = await import(
  MODULE_URL
);
const { FeatureIdAttribute, FeatureIdImplicitRange } = await import(
  pathToFileURL(resolve(ENGINE_SOURCE, "Scene/ModelComponents.js")).href
);

function replaceOnce(candidate, search, replacement, message) {
  const mutated = candidate.replace(search, replacement);
  assert.notEqual(mutated, candidate, message);
  return mutated;
}

function isAssertionError(error) {
  return error instanceof assert.AssertionError;
}

async function loadMutatedInstancingModule(source, mutationName) {
  const bundle = await build({
    stdin: {
      contents:
        'export { ensureInstancingResources } from "./Renderer/WebGPU/WebGPUModelInstancing.js"; export { FeatureIdImplicitRange } from "./Scene/ModelComponents.js";',
      resolveDir: ENGINE_SOURCE,
      sourcefile: `model-instancing-${mutationName}-entry.mjs`,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: `model-instancing-${mutationName}`,
        setup(buildApi) {
          buildApi.onLoad({ filter: /WebGPUModelInstancing\.js$/ }, (args) => ({
            contents: source,
            loader: "js",
            resolveDir: dirname(args.path),
          }));
        },
      },
    ],
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(
    bundle.outputFiles[0].text,
  ).toString("base64")}#${encodeURIComponent(mutationName)}`;
  return import(moduleUrl);
}

class FakeBuffer {
  constructor(label, size) {
    this.label = label;
    this.size = size;
    this.data = undefined;
    this.destroyCalls = 0;
    this.throwOnDestroy = false;
    this.onDestroy = undefined;
  }

  destroy() {
    this.destroyCalls++;
    const onDestroy = this.onDestroy;
    if (typeof onDestroy === "function") {
      this.onDestroy = undefined;
      onDestroy();
    }
    if (this.throwOnDestroy) {
      throw new Error(`destroy failed: ${this.label}`);
    }
  }
}

class FakeQueue {
  constructor() {
    this.writeCalls = 0;
    this.nonFiniteWriteCalls = 0;
    this.completions = [];
    this.failWrite = false;
    this.onWriteBuffer = undefined;
  }

  writeBuffer(buffer, offset, data) {
    assert.equal(offset, 0);
    this.writeCalls++;
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i])) {
        this.nonFiniteWriteCalls++;
        break;
      }
    }
    const onWriteBuffer = this.onWriteBuffer;
    if (typeof onWriteBuffer === "function") {
      this.onWriteBuffer = undefined;
      onWriteBuffer();
    }
    if (this.failWrite) {
      throw new Error("write failed");
    }
    buffer.data = new Float32Array(data);
  }

  onSubmittedWorkDone() {
    let resolveCompletion;
    let rejectCompletion;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolveCompletion = resolvePromise;
      rejectCompletion = rejectPromise;
    });
    this.completions.push({
      resolve: resolveCompletion,
      reject: rejectCompletion,
    });
    return promise;
  }

  resolveNext() {
    const completion = this.completions.shift();
    assert.ok(completion, "expected a pending queue completion");
    completion.resolve();
  }

  rejectNext() {
    const completion = this.completions.shift();
    assert.ok(completion, "expected a pending queue completion");
    completion.reject(new Error("device lost"));
  }
}

class FakeDevice {
  constructor() {
    this.queue = new FakeQueue();
    this.buffers = [];
    this.createCalls = 0;
    this.failCreate = false;
    this.onCreateBuffer = undefined;
  }

  createBuffer(descriptor) {
    this.createCalls++;
    if (this.failCreate) {
      throw new Error("create failed");
    }
    const onCreateBuffer = this.onCreateBuffer;
    if (typeof onCreateBuffer === "function") {
      this.onCreateBuffer = undefined;
      onCreateBuffer();
    }
    const buffer = new FakeBuffer(descriptor.label, descriptor.size);
    this.buffers.push(buffer);
    return buffer;
  }
}

function makeContext(label = "encoder-a") {
  const context = {
    currentCommandEncoder: { label },
    callbacks: [],
    accepted: true,
    throwOnEnqueue: false,
    enqueueAfterCommandEncoderSubmit(encoder, callback) {
      if (context.throwOnEnqueue) {
        throw new Error("enlistment failed");
      }
      if (!context.accepted) {
        return false;
      }
      context.callbacks.push({ encoder, callback });
      return true;
    },
  };
  return context;
}

function explicitSource(label, positionalLabel, propertyTableId, setIndex) {
  const source = new FeatureIdAttribute();
  source.label = label;
  source.positionalLabel = positionalLabel;
  source.propertyTableId = propertyTableId;
  source.setIndex = setIndex;
  return source;
}

function implicitSource(
  label,
  positionalLabel,
  propertyTableId,
  offset,
  repeat,
) {
  const source = new FeatureIdImplicitRange();
  source.label = label;
  source.positionalLabel = positionalLabel;
  source.propertyTableId = propertyTableId;
  source.offset = offset;
  source.repeat = repeat;
  return source;
}

function makePackedTransforms(count, translationBias = 0) {
  const packed = new Float32Array(count * 12);
  for (let i = 0; i < count; i++) {
    const base = i * 12;
    packed[base + 0] = 1;
    packed[base + 5] = 1;
    packed[base + 10] = 1;
    packed[base + 3] = translationBias + i;
  }
  return packed;
}

function makeHarness(count = 4) {
  const tableA = { id: 0, class: {}, count: 32 };
  const tableB = { id: 1, class: {}, count: 32 };
  const sourceA = explicitSource("a", "instanceFeatureId_0", 0, 0);
  const sourceB = explicitSource("b", "instanceFeatureId_1", 1, 1);
  const sourceImplicit = implicitSource(
    "implicit",
    "instanceFeatureId_2",
    0,
    7,
    2,
  );
  const attributeA = {
    semantic: "_FEATURE_ID",
    setIndex: 0,
    typedArray: new Uint16Array([1, 2, 3, 4]),
  };
  const attributeB = {
    semantic: "_FEATURE_ID",
    setIndex: 1,
    typedArray: new Uint16Array([9, 8, 7, 6]),
  };
  const instances = {
    attributes: [
      {
        semantic: "TRANSLATION",
        count,
        typedArray: new Float32Array(count * 3),
      },
      attributeA,
      attributeB,
    ],
    featureIds: [sourceA, sourceB, sourceImplicit],
  };
  const model = {
    instanceFeatureIdLabel: "a",
    featureTableId: 0,
    structuralMetadata: {
      propertyTables: [tableA, tableB],
    },
  };
  const runtimeNode = {
    node: { instances },
    transformsTypedArray: makePackedTransforms(count),
  };
  return {
    count,
    tableA,
    tableB,
    sourceA,
    sourceB,
    sourceImplicit,
    attributeA,
    attributeB,
    instances,
    model,
    runtimeNode,
    nodeCache: {},
    device: new FakeDevice(),
    context: makeContext(),
  };
}

function ensureWith(ensureFunction, harness) {
  return ensureFunction(
    harness.device,
    harness.nodeCache,
    harness.runtimeNode,
    harness.model,
    harness.context,
  );
}

function ensure(harness) {
  return ensureWith(ensureInstancingResources, harness);
}

function makeCardinalityHarness(kind) {
  const count = 4;
  const translationLength =
    kind === "translation" ? (count - 1) * 3 : count * 3;
  const attributes = [
    {
      semantic: "TRANSLATION",
      count,
      typedArray: new Float32Array(translationLength),
    },
  ];
  if (kind === "rotation") {
    attributes.push({
      semantic: "ROTATION",
      count,
      typedArray: new Float32Array((count - 1) * 4),
    });
  } else if (kind === "scale") {
    attributes.push({
      semantic: "SCALE",
      count,
      typedArray: new Float32Array((count - 1) * 3),
    });
  }
  const instances = { attributes, featureIds: [] };
  return {
    count,
    device: new FakeDevice(),
    nodeCache: {},
    runtimeNode: {
      node: { instances },
      transformsTypedArray:
        kind === "packed" ? makePackedTransforms(count - 1) : undefined,
    },
    model: undefined,
    context: undefined,
  };
}

function makeImplicitCardinalityHarness(FeatureIdImplicitRangeConstructor) {
  const harness = makeCardinalityHarness("implicit");
  const source = new FeatureIdImplicitRangeConstructor();
  source.label = "implicit";
  source.positionalLabel = "instanceFeatureId_0";
  source.propertyTableId = 0;
  source.offset = 0;
  source.repeat = 1;
  harness.runtimeNode.node.instances.featureIds = [source];
  harness.model = {
    instanceFeatureIdLabel: "implicit",
    structuralMetadata: {
      propertyTables: [{ count: harness.count }],
    },
  };
  return harness;
}

function assertCardinalityFailsClosed(ensureFunction, harness, label) {
  let result;
  assert.doesNotThrow(() => {
    result = ensureWith(ensureFunction, harness);
  }, label);
  assert.equal(result, null, label);
  assert.equal(harness.device.createCalls, 0, label);
  assert.equal(harness.device.buffers.length, 0, label);
  assert.equal(harness.device.queue.writeCalls, 0, label);
  assert.equal(harness.device.queue.nonFiniteWriteCalls, 0, label);
}

function isDeveloperErrorAssertion(error) {
  return (
    isAssertionError(error) &&
    error.actual?.name === "DeveloperError" &&
    /Expected value to be typeof number/.test(error.actual.message)
  );
}

function featureIds(buffer, count) {
  assert.ok(buffer.data, "buffer must have uploaded data");
  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push(buffer.data[i * 24 + 19]);
  }
  return ids;
}

function translationXs(buffer, count) {
  assert.ok(buffer.data, "buffer must have uploaded data");
  const translations = [];
  for (let i = 0; i < count; i++) {
    const base = i * 24;
    translations.push(buffer.data[base + 16] + buffer.data[base + 20]);
  }
  return translations;
}

function prepareLateMutationCase(mode, path) {
  const h = makeHarness(2);
  h.context.accepted = false;
  const triggerRead = path === "replacement" ? 6 : 2;
  let observedReads = 0;
  let armed = false;
  let installCandidateA;
  let assertFinal;

  function observe(mutate) {
    observedReads++;
    if (armed && observedReads === triggerRead) {
      mutate();
    }
    return 1;
  }

  if (mode === "none") {
    const transformsA = makePackedTransforms(2, 1);
    const transformsB = makePackedTransforms(2, 100);
    const transformsC = makePackedTransforms(2, 10);
    h.model.instanceFeatureIdLabel = "missing";
    h.runtimeNode.transformsTypedArray =
      path === "replacement" ? transformsC : transformsA;
    const nonmatchingLabel = h.sourceImplicit.label;
    Object.defineProperty(h.sourceImplicit, "label", {
      configurable: true,
      get() {
        observe(() => {
          h.runtimeNode.transformsTypedArray = transformsB;
        });
        return nonmatchingLabel;
      },
    });
    installCandidateA = function () {
      h.runtimeNode.transformsTypedArray = transformsA;
    };
    assertFinal = function (result) {
      assert.equal(
        h.nodeCache.instancingProvenance.packedTransforms,
        transformsB,
      );
      assert.deepEqual(translationXs(result.storageBuffer, 2), [100, 101]);
      assert.deepEqual(featureIds(result.storageBuffer, 2), [0, 0]);
    };
  } else if (mode === "implicit") {
    const sourceA = implicitSource("late-implicit", "late_implicit", 0, 20, 2);
    const sourceB = implicitSource("late-implicit", "late_implicit", 0, 50, 1);
    const sourceC = implicitSource("late-implicit", "late_implicit", 0, 10, 2);
    h.model.instanceFeatureIdLabel = "late-implicit";
    h.instances.featureIds[0] = path === "replacement" ? sourceC : sourceA;
    Object.defineProperty(h.tableA, "_webgpuMetadataRevision", {
      configurable: true,
      get() {
        return observe(() => {
          h.instances.featureIds[0] = sourceB;
        });
      },
    });
    installCandidateA = function () {
      h.instances.featureIds[0] = sourceA;
    };
    assertFinal = function (result) {
      assert.equal(h.nodeCache.instancingProvenance.featureSource, sourceB);
      assert.deepEqual(featureIds(result.storageBuffer, 2), [50, 51]);
    };
  } else {
    const dataA = new Uint16Array([1, 2]);
    const dataB = new Uint16Array([9, 8]);
    const dataC = new Uint16Array([4, 3]);
    const revisionGetter = function () {
      return observe(() => {
        h.attributeA.typedArray = dataB;
      });
    };
    for (const data of [dataA, dataB, dataC]) {
      Object.defineProperty(data, "_webgpuGeometryRevision", {
        configurable: true,
        get: revisionGetter,
      });
    }
    h.attributeA.typedArray = path === "replacement" ? dataC : dataA;
    installCandidateA = function () {
      h.attributeA.typedArray = dataA;
    };
    assertFinal = function (result) {
      assert.equal(h.nodeCache.instancingProvenance.featureData, dataB);
      assert.deepEqual(featureIds(result.storageBuffer, 2), [9, 8]);
    };
  }

  let warm;
  if (path !== "initial") {
    warm = ensure(h);
  }
  if (path === "replacement") {
    installCandidateA();
  }
  observedReads = 0;
  armed = true;
  return {
    h,
    warm,
    assertFinal,
    get observedReads() {
      return observedReads;
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

async function settleOneRetirement(harness, submitted = true, reject = false) {
  const entry = harness.context.callbacks.shift();
  assert.ok(entry, "expected an exact-encoder callback");
  entry.callback(submitted);
  assert.equal(
    harness.device.queue.completions.length,
    1,
    "exact settlement must arm one GPU-completion fence",
  );
  if (reject) {
    harness.device.queue.rejectNext();
  } else {
    harness.device.queue.resolveNext();
  }
  await flushPromises();
  return entry;
}

test("short packed transforms fail closed before GPU work", () => {
  assertCardinalityFailsClosed(
    ensureInstancingResources,
    makeCardinalityHarness("packed"),
    "packed transforms",
  );
});

test("short fallback transform arrays fail closed before GPU work", () => {
  for (const kind of ["translation", "rotation", "scale"]) {
    assertCardinalityFailsClosed(
      ensureInstancingResources,
      makeCardinalityHarness(kind),
      kind,
    );
  }
});

test("short selected feature ID data fails closed before GPU work", () => {
  const h = makeHarness();
  h.attributeA.typedArray = new Uint16Array(h.count - 1);
  assertCardinalityFailsClosed(
    ensureInstancingResources,
    h,
    "selected feature IDs",
  );
});

test("generated feature ID cardinality is checked before GPU work", async () => {
  const source = await readFile(INSTANCING_SOURCE_PATH, "utf8");
  const shortFeatureIdsSource = replaceOnce(
    source,
    "const out = new Float32Array(count);",
    "const out = new Float32Array(Math.max(0, count - 1));",
    "generated feature ID control must shorten the array",
  );
  const mutatedModule = await loadMutatedInstancingModule(
    shortFeatureIdsSource,
    "short-generated-feature-ids",
  );
  assertCardinalityFailsClosed(
    mutatedModule.ensureInstancingResources,
    makeImplicitCardinalityHarness(mutatedModule.FeatureIdImplicitRange),
    "generated feature IDs",
  );
});

test("packed and fallback cardinality tests kill absent and inert guards", async () => {
  const source = await readFile(INSTANCING_SOURCE_PATH, "utf8");
  const guardPattern =
    / {2}if \(\r?\n {4}!instancingCardinalityAllows\(candidateProvenance, count, instanceFeatureIds\)\r?\n {2}\) \{\r?\n {4}return null;\r?\n {2}\}\r?\n/;
  const absenceWithoutPrimary = replaceOnce(
    source,
    guardPattern,
    "",
    "cardinality absence mutant must delete the primary guard",
  );
  const internalGuardPattern =
    / {2}if \(!cardinalityAllows\) \{\r?\n {4}return null;\r?\n {2}\}\r?\n/;
  const absenceWithoutPacked = replaceOnce(
    absenceWithoutPrimary,
    internalGuardPattern,
    "",
    "cardinality absence mutant must delete the packed guard",
  );
  const absenceSource = replaceOnce(
    absenceWithoutPacked,
    internalGuardPattern,
    "",
    "cardinality absence mutant must delete the fallback guard",
  );

  const primaryPredicate =
    "!instancingCardinalityAllows(candidateProvenance, count, instanceFeatureIds)";
  const inertnessWithoutPrimary = replaceOnce(
    source,
    primaryPredicate,
    `false && ${primaryPredicate}`,
    "cardinality inertness mutant must disable the primary guard",
  );
  const inertnessWithoutPacked = replaceOnce(
    inertnessWithoutPrimary,
    "if (!cardinalityAllows)",
    "if (false && !cardinalityAllows)",
    "cardinality inertness mutant must disable the packed guard",
  );
  const inertnessSource = replaceOnce(
    inertnessWithoutPacked,
    "if (!cardinalityAllows)",
    "if (false && !cardinalityAllows)",
    "cardinality inertness mutant must disable the fallback guard",
  );
  const [absenceModule, inertnessModule] = await Promise.all([
    loadMutatedInstancingModule(absenceSource, "cardinality-absence"),
    loadMutatedInstancingModule(inertnessSource, "cardinality-inertness"),
  ]);

  for (const [mutation, mutatedEnsure] of [
    ["absence", absenceModule.ensureInstancingResources],
    ["inertness", inertnessModule.ensureInstancingResources],
  ]) {
    for (const kind of ["packed", "translation"]) {
      assert.throws(
        () =>
          assertCardinalityFailsClosed(
            mutatedEnsure,
            makeCardinalityHarness(kind),
            `${mutation} ${kind}`,
          ),
        isDeveloperErrorAssertion,
        `${mutation} ${kind} mutant must restore the debug cardinality failure`,
      );
    }
  }
});

test("semantic label transitions rebuild exact feature IDs and aliases stay stable", async () => {
  const h = makeHarness();

  const first = ensure(h);
  assert.deepEqual(featureIds(first.storageBuffer, h.count), [1, 2, 3, 4]);
  assert.equal(h.device.createCalls, 1);
  assert.equal(h.device.queue.writeCalls, 1);

  const stable = ensure(h);
  assert.equal(stable, first);
  assert.equal(stable.storageBuffer, first.storageBuffer);
  assert.equal(h.device.createCalls, 1);
  assert.equal(h.context.callbacks.length, 0);

  h.sourceA.positionalLabel = "alias-a";
  h.model.instanceFeatureIdLabel = "alias-a";
  h.model.featureTableId = 99;
  const alias = ensure(h);
  assert.equal(alias.storageBuffer, first.storageBuffer);
  assert.equal(h.device.createCalls, 1);

  h.model.instanceFeatureIdLabel = "b";
  const explicitB = ensure(h);
  assert.notEqual(explicitB.storageBuffer, first.storageBuffer);
  assert.deepEqual(featureIds(explicitB.storageBuffer, h.count), [9, 8, 7, 6]);
  assert.equal(first.storageBuffer.destroyCalls, 0);
  const explicitRetirement = h.context.callbacks[0];
  assert.equal(explicitRetirement.encoder.label, "encoder-a");
  explicitRetirement.callback(true);
  assert.equal(first.storageBuffer.destroyCalls, 0);
  h.context.callbacks.shift();
  h.device.queue.resolveNext();
  await flushPromises();
  assert.equal(first.storageBuffer.destroyCalls, 1);

  h.model.instanceFeatureIdLabel = "implicit";
  const implicit = ensure(h);
  assert.deepEqual(featureIds(implicit.storageBuffer, h.count), [7, 7, 8, 8]);
  await settleOneRetirement(h, false);
  assert.equal(explicitB.storageBuffer.destroyCalls, 1);

  h.model.instanceFeatureIdLabel = "missing";
  const none = ensure(h);
  assert.deepEqual(featureIds(none.storageBuffer, h.count), [0, 0, 0, 0]);
  await settleOneRetirement(h);

  h.model.instanceFeatureIdLabel = "a";
  const validAgain = ensure(h);
  assert.deepEqual(featureIds(validAgain.storageBuffer, h.count), [1, 2, 3, 4]);
  await settleOneRetirement(h);
});

test("live source, table, typed-array, and transform provenance invalidate independently", async () => {
  const h = makeHarness();
  h.context.accepted = false;
  const first = ensure(h);

  const replacementValues = new Uint16Array([4, 3, 2, 1]);
  h.attributeA.typedArray = replacementValues;
  const dataReplacement = ensure(h);
  assert.notEqual(dataReplacement.storageBuffer, first.storageBuffer);
  assert.deepEqual(
    featureIds(dataReplacement.storageBuffer, h.count),
    [4, 3, 2, 1],
  );

  replacementValues._webgpuMetadataRevision = 1;
  replacementValues[0] = 12;
  const dataRevision = ensure(h);
  assert.notEqual(dataRevision.storageBuffer, dataReplacement.storageBuffer);
  assert.deepEqual(
    featureIds(dataRevision.storageBuffer, h.count),
    [12, 3, 2, 1],
  );

  const replacementTable = { id: 0, class: {}, count: 32 };
  h.model.structuralMetadata.propertyTables[0] = replacementTable;
  const tableReplacement = ensure(h);
  assert.notEqual(tableReplacement.storageBuffer, dataRevision.storageBuffer);

  replacementTable._metadataRevision = 1;
  const tableRevision = ensure(h);
  assert.notEqual(tableRevision.storageBuffer, tableReplacement.storageBuffer);

  h.runtimeNode.transformsTypedArray = makePackedTransforms(h.count, 100);
  const transformReplacement = ensure(h);
  assert.notEqual(
    transformReplacement.storageBuffer,
    tableRevision.storageBuffer,
  );

  h.runtimeNode.transformsTypedArray._webgpuGeometryRevision = 1;
  const transformRevision = ensure(h);
  assert.notEqual(
    transformRevision.storageBuffer,
    transformReplacement.storageBuffer,
  );

  h.model.instanceFeatureIdLabel = "implicit";
  const implicit = ensure(h);
  h.sourceImplicit.offset = 10;
  const implicitOffset = ensure(h);
  assert.notEqual(implicitOffset.storageBuffer, implicit.storageBuffer);
  assert.deepEqual(
    featureIds(implicitOffset.storageBuffer, h.count),
    [10, 10, 11, 11],
  );
  h.sourceImplicit.repeat = 1;
  const implicitRepeat = ensure(h);
  assert.notEqual(implicitRepeat.storageBuffer, implicitOffset.storageBuffer);
  assert.deepEqual(
    featureIds(implicitRepeat.storageBuffer, h.count),
    [10, 11, 12, 13],
  );

  h.model.instanceFeatureIdLabel = "a";
  const replacementSource = explicitSource("a", "instanceFeatureId_0", 0, 0);
  h.instances.featureIds[0] = replacementSource;
  const sourceReplacement = ensure(h);
  assert.notEqual(
    sourceReplacement.storageBuffer,
    implicitRepeat.storageBuffer,
  );

  const replacementAttribute = {
    semantic: "_FEATURE_ID",
    setIndex: 0,
    typedArray: h.attributeA.typedArray,
  };
  h.instances.attributes[1] = replacementAttribute;
  const attributeReplacement = ensure(h);
  assert.notEqual(
    attributeReplacement.storageBuffer,
    sourceReplacement.storageBuffer,
  );

  const replacementInstances = {
    ...h.instances,
    attributes: h.instances.attributes.slice(),
    featureIds: h.instances.featureIds.slice(),
  };
  h.runtimeNode.node.instances = replacementInstances;
  const containerReplacement = ensure(h);
  assert.notEqual(
    containerReplacement.storageBuffer,
    attributeReplacement.storageBuffer,
  );

  replacementInstances.attributes[0].count = 3;
  const countReplacement = ensure(h);
  assert.notEqual(
    countReplacement.storageBuffer,
    containerReplacement.storageBuffer,
  );
  assert.equal(countReplacement.instanceCount, 3);

  const createCount = h.device.createCalls;
  const stable = ensure(h);
  assert.equal(stable.storageBuffer, countReplacement.storageBuffer);
  assert.equal(h.device.createCalls, createCount);
  assert.equal(h.context.callbacks.length, 0);
});

test("missing explicit data and non-live tables fail closed instead of retaining stale IDs", () => {
  const h = makeHarness();
  h.context.accepted = false;
  const first = ensure(h);
  assert.deepEqual(featureIds(first.storageBuffer, h.count), [1, 2, 3, 4]);

  h.attributeA.typedArray = undefined;
  const missingData = ensure(h);
  assert.equal(missingData, null);
  assert.equal(h.nodeCache.instancingBuffer, first.storageBuffer);

  h.attributeA.typedArray = new Uint16Array([5, 6, 7, 8]);
  const restoredData = ensure(h);
  assert.deepEqual(
    featureIds(restoredData.storageBuffer, h.count),
    [5, 6, 7, 8],
  );

  h.tableA.count = 0;
  const emptyTable = ensure(h);
  assert.deepEqual(featureIds(emptyTable.storageBuffer, h.count), [0, 0, 0, 0]);

  h.tableA.count = 32;
  h.model.structuralMetadata.propertyTables[0] = undefined;
  const missingTable = ensure(h);
  assert.equal(missingTable.storageBuffer, emptyTable.storageBuffer);

  h.model.structuralMetadata.propertyTables[0] = h.tableA;
  const liveAgain = ensure(h);
  assert.deepEqual(featureIds(liveAgain.storageBuffer, h.count), [5, 6, 7, 8]);
});

test("legacy indexed property tables need neither a modern id nor class", () => {
  const h = makeHarness();
  h.tableA.id = undefined;
  h.tableA.class = undefined;

  const result = ensure(h);
  assert.deepEqual(featureIds(result.storageBuffer, h.count), [1, 2, 3, 4]);
});

test("candidate allocation and upload failures preserve the exact incumbent tuple", () => {
  const h = makeHarness();
  const first = ensure(h);
  const incumbentProvenance = h.nodeCache.instancingProvenance;
  const incumbentRetired = h.nodeCache.retiredInstancingBuffers;
  h.model.instanceFeatureIdLabel = "b";

  h.device.failCreate = true;
  assert.throws(() => ensure(h), /create failed/);
  assert.equal(h.nodeCache.instancingBuffer, first.storageBuffer);
  assert.equal(h.nodeCache.instancingProvenance, incumbentProvenance);
  assert.equal(h.nodeCache.retiredInstancingBuffers, incumbentRetired);
  assert.equal(h.context.callbacks.length, 0);

  h.device.failCreate = false;
  h.device.queue.failWrite = true;
  assert.throws(() => ensure(h), /write failed/);
  const failedCandidate = h.device.buffers.at(-1);
  assert.equal(failedCandidate.destroyCalls, 1);
  assert.equal(h.nodeCache.instancingBuffer, first.storageBuffer);
  assert.equal(h.nodeCache.instancingProvenance, incumbentProvenance);
  assert.equal(h.nodeCache.retiredInstancingBuffers, incumbentRetired);
  assert.equal(h.context.callbacks.length, 0);

  h.device.queue.failWrite = false;
  const recovered = ensure(h);
  assert.notEqual(recovered.storageBuffer, first.storageBuffer);
  assert.deepEqual(featureIds(recovered.storageBuffer, h.count), [9, 8, 7, 6]);
});

test("re-entrant creation cannot overwrite a newer live generation", () => {
  const h = makeHarness(2);
  let nestedResult;
  h.device.onCreateBuffer = function () {
    h.model.instanceFeatureIdLabel = "b";
    nestedResult = ensure(h);
  };

  const outerResult = ensure(h);
  assert.ok(nestedResult);
  assert.equal(outerResult, nestedResult);
  assert.equal(h.nodeCache.instancingResources, nestedResult);
  assert.equal(h.nodeCache.instancingBuffer, nestedResult.storageBuffer);
  assert.deepEqual(featureIds(nestedResult.storageBuffer, h.count), [9, 8]);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.queue.writeCalls, 2);
  assert.equal(h.nodeCache.instancingPublicationEpoch, 1);
  assert.equal(h.nodeCache.retiredInstancingBuffers, undefined);
  assert.equal(h.context.callbacks.length, 0);

  const staleOuterBuffer = h.device.buffers.find(
    (buffer) => buffer !== nestedResult.storageBuffer,
  );
  assert.ok(staleOuterBuffer);
  assert.equal(staleOuterBuffer.destroyCalls, 1);
  assert.equal(nestedResult.storageBuffer.destroyCalls, 0);
});

test("post-upload validation re-resolves a live instance-count change", () => {
  const h = makeHarness(2);
  h.runtimeNode.transformsTypedArray = makePackedTransforms(3);
  h.device.onCreateBuffer = function () {
    h.instances.attributes[0].count = 3;
  };

  const result = ensure(h);

  assert.equal(result.instanceCount, 3);
  assert.deepEqual(featureIds(result.storageBuffer, 3), [1, 2, 3]);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.queue.writeCalls, 2);
  assert.equal(h.device.buffers[0].destroyCalls, 1);
  assert.equal(result.storageBuffer.destroyCalls, 0);
  assert.equal(h.nodeCache.instancingPublicationEpoch, 1);
});

test("post-upload validation re-resolves a whole runtime-node replacement", () => {
  const h = makeHarness(2);
  const replacementSource = explicitSource("a", "instanceFeatureId_0", 0, 0);
  const replacementInstances = {
    attributes: [
      {
        semantic: "TRANSLATION",
        count: 2,
        typedArray: new Float32Array(6),
      },
      {
        semantic: "_FEATURE_ID",
        setIndex: 0,
        typedArray: new Uint16Array([5, 6]),
      },
    ],
    featureIds: [replacementSource],
  };
  h.device.queue.onWriteBuffer = function () {
    h.runtimeNode.node = { instances: replacementInstances };
  };

  const result = ensure(h);

  assert.deepEqual(featureIds(result.storageBuffer, 2), [5, 6]);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.queue.writeCalls, 2);
  assert.equal(h.device.buffers[0].destroyCalls, 1);
  assert.equal(result.storageBuffer.destroyCalls, 0);
  assert.equal(
    h.nodeCache.instancingProvenance.instances,
    replacementInstances,
  );
  assert.equal(h.nodeCache.instancingPublicationEpoch, 1);
});

test("nested revision getters use depth-isolated provenance scratch", () => {
  const h = makeHarness(2);
  const transformsA = makePackedTransforms(2, 11);
  const transformsB = makePackedTransforms(2, 22);
  Object.defineProperty(transformsB, "_webgpuGeometryRevision", {
    value: 1,
  });
  let shouldReenter = true;
  let nestedResult;
  Object.defineProperty(transformsA, "_webgpuGeometryRevision", {
    configurable: true,
    get() {
      if (shouldReenter) {
        shouldReenter = false;
        h.runtimeNode.transformsTypedArray = transformsB;
        nestedResult = ensure(h);
        h.runtimeNode.transformsTypedArray = transformsA;
      }
      return 1;
    },
  });
  h.runtimeNode.transformsTypedArray = transformsA;

  const result = ensure(h);

  assert.ok(nestedResult);
  assert.notEqual(result.storageBuffer, nestedResult.storageBuffer);
  assert.deepEqual(translationXs(nestedResult.storageBuffer, 2), [22, 23]);
  assert.deepEqual(translationXs(result.storageBuffer, 2), [11, 12]);
  assert.equal(h.runtimeNode.transformsTypedArray, transformsA);
  assert.equal(h.nodeCache.instancingProvenance.packedTransforms, transformsA);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.queue.writeCalls, 2);
  assert.equal(h.nodeCache.instancingPublicationEpoch, 2);
  assert.equal(h.context.callbacks.length, 1);

  const scratchPool = h.nodeCache.instancingProvenanceScratchPool;
  assert.equal(scratchPool.length, 3);
  assert.equal(h.nodeCache.instancingProvenanceScratchDepth, 0);
  assert.equal(ensure(h), result);
  assert.equal(h.nodeCache.instancingProvenanceScratchPool, scratchPool);
  assert.equal(h.device.createCalls, 2);
});

test("late provenance getter failure destroys only the unpublished candidate", () => {
  const h = makeHarness(2);
  const transforms = makePackedTransforms(2, 7);
  let revisionReads = 0;
  Object.defineProperty(transforms, "_webgpuGeometryRevision", {
    get() {
      revisionReads++;
      if (revisionReads === 3) {
        throw new Error("latest provenance failed");
      }
      return 1;
    },
  });
  h.runtimeNode.transformsTypedArray = transforms;

  assert.throws(() => ensure(h), /latest provenance failed/);

  assert.equal(h.device.createCalls, 1);
  assert.equal(h.device.queue.writeCalls, 1);
  assert.equal(h.device.buffers[0].destroyCalls, 1);
  assert.equal(h.nodeCache.instancingBuffer, undefined);
  assert.equal(h.nodeCache.instancingResources, undefined);
  assert.equal(h.nodeCache.instancingPublicationEpoch, undefined);
  assert.equal(h.nodeCache.instancingProvenanceScratchDepth, 0);

  const recovered = ensure(h);
  assert.deepEqual(translationXs(recovered.storageBuffer, 2), [7, 8]);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.buffers[1].destroyCalls, 0);
});

test("late provenance mutation fails tracked closure and retries the live tuple", () => {
  const h = makeHarness(2);
  const transformsA = makePackedTransforms(2, 1);
  const transformsB = makePackedTransforms(2, 100);
  Object.defineProperty(transformsB, "_webgpuGeometryRevision", {
    value: 7,
  });
  let revisionReads = 0;
  Object.defineProperty(transformsA, "_webgpuGeometryRevision", {
    get() {
      revisionReads++;
      if (revisionReads === 3) {
        h.runtimeNode.transformsTypedArray = transformsB;
      }
      return 7;
    },
  });
  h.runtimeNode.transformsTypedArray = transformsA;

  const result = ensure(h);

  assert.equal(h.runtimeNode.transformsTypedArray, transformsB);
  assert.equal(h.nodeCache.instancingProvenance.packedTransforms, transformsB);
  assert.deepEqual(translationXs(result.storageBuffer, 2), [100, 101]);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.queue.writeCalls, 2);
  assert.equal(h.device.buffers[0].destroyCalls, 1);
  assert.equal(result.storageBuffer.destroyCalls, 0);
  assert.equal(h.nodeCache.instancingPublicationEpoch, 1);
});

test("two complete observations catch mutation from the final node getter", () => {
  const h = makeHarness(1);
  const packed = makePackedTransforms(1, 1);
  let revision = 1;
  Object.defineProperty(packed, "_webgpuGeometryRevision", {
    get() {
      return revision;
    },
  });
  h.runtimeNode.transformsTypedArray = packed;
  const stableNode = h.runtimeNode.node;
  let nodeReads = 0;
  Object.defineProperty(h.runtimeNode, "node", {
    configurable: true,
    get() {
      nodeReads++;
      if (nodeReads === 4) {
        packed[3] = 100;
        revision = 2;
      }
      return stableNode;
    },
  });

  const result = ensure(h);

  assert.equal(nodeReads, 8);
  assert.equal(packed[3], 100);
  assert.equal(h.nodeCache.instancingProvenance.packedTransformsRevision, 2);
  assert.deepEqual(translationXs(result.storageBuffer, 1), [100]);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.queue.writeCalls, 2);
  assert.equal(h.device.buffers[0].destroyCalls, 1);
  assert.equal(result.storageBuffer.destroyCalls, 0);
  assert.equal(h.nodeCache.instancingPublicationEpoch, 1);
});

test("tracked closure converges every feature mode on a late stable-hit mutation", () => {
  for (const mode of ["none", "implicit", "explicit"]) {
    const prepared = prepareLateMutationCase(mode, "stable");
    const { h, warm } = prepared;
    const createsBefore = h.device.createCalls;
    const writesBefore = h.device.queue.writeCalls;

    const result = ensure(h);

    assert.notEqual(result, warm, mode);
    assert.equal(prepared.observedReads, 8, mode);
    assert.equal(h.device.createCalls - createsBefore, 1, mode);
    assert.equal(h.device.queue.writeCalls - writesBefore, 1, mode);
    assert.equal(h.nodeCache.instancingPublicationEpoch, 2, mode);
    assert.equal(h.nodeCache.instancingResources, result, mode);
    assert.equal(h.context.callbacks.length, 0, mode);
    assert.equal(h.device.queue.completions.length, 0, mode);
    assert.ok(h.device.buffers.every((buffer) => buffer.destroyCalls === 0));
    assert.equal(h.nodeCache.instancingProvenanceScratchDepth, 0, mode);
    assert.equal(h.nodeCache.instancingConvergenceDepth, undefined, mode);
    assert.equal(h.nodeCache.instancingConvergenceRemaining, undefined, mode);
    prepared.assertFinal(result);

    const stableCreates = h.device.createCalls;
    assert.equal(ensure(h), result, mode);
    assert.equal(h.device.createCalls, stableCreates, mode);
  }
});

test("tracked closure converges every feature mode on a late initial mutation", () => {
  for (const mode of ["none", "implicit", "explicit"]) {
    const prepared = prepareLateMutationCase(mode, "initial");
    const { h } = prepared;

    const result = ensure(h);

    assert.equal(prepared.observedReads, 6, mode);
    assert.equal(h.device.createCalls, 1, mode);
    assert.equal(h.device.queue.writeCalls, 1, mode);
    assert.equal(h.nodeCache.instancingPublicationEpoch, 1, mode);
    assert.equal(h.nodeCache.instancingResources, result, mode);
    assert.equal(h.nodeCache.retiredInstancingBuffers, undefined, mode);
    assert.equal(h.context.callbacks.length, 0, mode);
    assert.equal(h.device.queue.completions.length, 0, mode);
    assert.equal(result.storageBuffer.destroyCalls, 0, mode);
    assert.equal(h.nodeCache.instancingProvenanceScratchDepth, 0, mode);
    assert.equal(h.nodeCache.instancingConvergenceDepth, undefined, mode);
    assert.equal(h.nodeCache.instancingConvergenceRemaining, undefined, mode);
    prepared.assertFinal(result);
  }
});

test("tracked closure converges every feature mode on final replacement revalidation", () => {
  for (const mode of ["none", "implicit", "explicit"]) {
    const prepared = prepareLateMutationCase(mode, "replacement");
    const { h, warm } = prepared;
    const createsBefore = h.device.createCalls;
    const writesBefore = h.device.queue.writeCalls;

    const result = ensure(h);

    assert.notEqual(result, warm, mode);
    assert.equal(prepared.observedReads, 12, mode);
    assert.equal(h.device.createCalls - createsBefore, 2, mode);
    assert.equal(h.device.queue.writeCalls - writesBefore, 2, mode);
    assert.equal(h.nodeCache.instancingPublicationEpoch, 3, mode);
    assert.equal(h.nodeCache.instancingResources, result, mode);
    assert.equal(h.context.callbacks.length, 0, mode);
    assert.equal(h.device.queue.completions.length, 0, mode);
    assert.ok(h.device.buffers.every((buffer) => buffer.destroyCalls === 0));
    assert.equal(h.nodeCache.instancingProvenanceScratchDepth, 0, mode);
    assert.equal(h.nodeCache.instancingConvergenceDepth, undefined, mode);
    assert.equal(h.nodeCache.instancingConvergenceRemaining, undefined, mode);
    prepared.assertFinal(result);

    const stableCreates = h.device.createCalls;
    assert.equal(ensure(h), result, mode);
    assert.equal(h.device.createCalls, stableCreates, mode);
  }
});

test("packed candidate materialization never re-reads live runtime transforms", () => {
  const h = makeHarness(1);
  const transformsA = makePackedTransforms(1, 1);
  const transientB = makePackedTransforms(1, 100);
  let transformReads = 0;
  Object.defineProperty(h.runtimeNode, "transformsTypedArray", {
    configurable: true,
    get() {
      transformReads++;
      return transformReads === 3 ? transientB : transformsA;
    },
  });

  const result = ensure(h);

  assert.equal(transformReads, 8);
  assert.equal(h.nodeCache.instancingProvenance.packedTransforms, transformsA);
  assert.deepEqual(translationXs(result.storageBuffer, 1), [1]);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.queue.writeCalls, 2);
  assert.equal(h.device.buffers[0].destroyCalls, 1);
  assert.equal(result.storageBuffer.destroyCalls, 0);
});

test("fallback candidate materialization uses only captured attribute arrays", () => {
  const h = makeHarness(2);
  const translationA = new Float32Array([1, 0, 0, 2, 0, 0]);
  const transientB = new Float32Array([100, 0, 0, 101, 0, 0]);
  const translationAttribute = h.instances.attributes[0];
  h.runtimeNode.transformsTypedArray = undefined;
  let translationReads = 0;
  Object.defineProperty(translationAttribute, "typedArray", {
    configurable: true,
    get() {
      translationReads++;
      return translationReads === 3 ? transientB : translationA;
    },
  });

  const result = ensure(h);

  assert.equal(translationReads, 8);
  assert.equal(h.nodeCache.instancingProvenance.translationData, translationA);
  assert.deepEqual(translationXs(result.storageBuffer, 2), [1, 2]);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.queue.writeCalls, 2);
  assert.equal(h.device.buffers[0].destroyCalls, 1);
  assert.equal(result.storageBuffer.destroyCalls, 0);
});

test("closure detects a data-to-accessor swap without invoking it", () => {
  const h = makeHarness(1);
  const transformsA = makePackedTransforms(1, 1);
  const transformsB = makePackedTransforms(1, 100);
  h.runtimeNode.transformsTypedArray = transformsA;
  const warm = ensure(h);
  let revisionReads = 0;
  let accessorReads = 0;
  Object.defineProperty(h.attributeA.typedArray, "_webgpuGeometryRevision", {
    configurable: true,
    get() {
      revisionReads++;
      if (revisionReads === 2) {
        Object.defineProperty(h.runtimeNode, "transformsTypedArray", {
          configurable: true,
          get() {
            accessorReads++;
            return transformsB;
          },
        });
      }
      return 1;
    },
  });
  h.device.onCreateBuffer = function () {
    assert.equal(
      accessorReads,
      2,
      "descriptor closure must not invoke the replacement accessor",
    );
  };

  const result = ensure(h);

  assert.notEqual(result, warm);
  assert.equal(h.nodeCache.instancingProvenance.packedTransforms, transformsB);
  assert.deepEqual(translationXs(result.storageBuffer, 1), [100]);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.queue.writeCalls, 2);
  assert.ok(accessorReads >= 6);
});

test("tracked closure includes backing-field selection decisions", () => {
  const h = makeHarness(2);
  h.context.accepted = false;
  const replacementSource = explicitSource("a", "instanceFeatureId_0", 0, 0);
  const replacementInstances = {
    attributes: [
      {
        semantic: "TRANSLATION",
        count: 2,
        typedArray: new Float32Array(6),
      },
      {
        semantic: "_FEATURE_ID",
        setIndex: 0,
        typedArray: new Uint16Array([9, 8]),
      },
    ],
    featureIds: [replacementSource],
  };
  const replacementNode = { instances: replacementInstances };
  let revisionReads = 0;
  Object.defineProperty(h.attributeA.typedArray, "_webgpuGeometryRevision", {
    configurable: true,
    get() {
      revisionReads++;
      if (revisionReads === 2) {
        h.runtimeNode._node = replacementNode;
      }
      return 1;
    },
  });

  const result = ensure(h);

  assert.equal(revisionReads, 2);
  assert.equal(h.nodeCache.instancingProvenance.node, replacementNode);
  assert.equal(
    h.nodeCache.instancingProvenance.instances,
    replacementInstances,
  );
  assert.deepEqual(featureIds(result.storageBuffer, 2), [9, 8]);
  assert.equal(h.device.createCalls, 1);
  assert.equal(h.device.queue.writeCalls, 1);
  assert.equal(result.storageBuffer.destroyCalls, 0);
  assert.equal(h.nodeCache.instancingPublicationEpoch, 1);
});

test("tracked closure includes feature-source prototype classification", () => {
  const h = makeHarness(2);
  h.context.accepted = false;
  h.sourceA.offset = 50;
  h.sourceA.repeat = 1;
  let revisionReads = 0;
  Object.defineProperty(h.attributeA.typedArray, "_webgpuGeometryRevision", {
    configurable: true,
    get() {
      revisionReads++;
      if (revisionReads === 2) {
        Object.setPrototypeOf(h.sourceA, FeatureIdImplicitRange.prototype);
      }
      return 1;
    },
  });

  const result = ensure(h);

  assert.equal(revisionReads, 2);
  assert.equal(h.nodeCache.instancingProvenance.featureSource, h.sourceA);
  assert.equal(h.nodeCache.instancingProvenance.featureData, undefined);
  assert.equal(h.nodeCache.instancingProvenance.implicitOffset, 50);
  assert.equal(h.nodeCache.instancingProvenance.implicitRepeat, 1);
  assert.deepEqual(featureIds(result.storageBuffer, 2), [50, 51]);
  assert.equal(h.device.createCalls, 1);
  assert.equal(h.device.queue.writeCalls, 1);
  assert.equal(result.storageBuffer.destroyCalls, 0);
  assert.equal(h.nodeCache.instancingPublicationEpoch, 1);
});

test("persistent snapshot instability is bounded and retryable next frame", () => {
  const h = makeHarness(2);
  const nodeA = h.runtimeNode.node;
  const nodeB = { instances: nodeA.instances };
  let nodeReads = 0;
  Object.defineProperty(h.runtimeNode, "node", {
    configurable: true,
    get() {
      nodeReads++;
      return nodeReads % 2 === 1 ? nodeA : nodeB;
    },
  });

  const unstable = ensure(h);

  assert.equal(unstable, null);
  assert.equal(nodeReads, 8);
  assert.equal(h.device.createCalls, 0);
  assert.equal(h.device.queue.writeCalls, 0);
  assert.equal(h.nodeCache.instancingProvenanceScratchPool.length, 2);
  assert.equal(h.nodeCache.instancingProvenanceScratchDepth, 0);
  assert.equal(h.nodeCache.instancingConvergenceDepth, undefined);
  assert.equal(h.nodeCache.instancingConvergenceRemaining, undefined);

  Object.defineProperty(h.runtimeNode, "node", {
    configurable: true,
    value: nodeA,
    writable: true,
  });
  const recovered = ensure(h);
  assert.ok(recovered);
  assert.equal(h.device.createCalls, 1);
  assert.equal(h.nodeCache.instancingConvergenceDepth, undefined);
  assert.equal(h.nodeCache.instancingConvergenceRemaining, undefined);
});

test("persistent post-upload instability preserves the incumbent exactly", () => {
  const h = makeHarness(1);
  h.context.accepted = false;
  const incumbent = ensure(h);
  const incumbentProvenance = h.nodeCache.instancingProvenance;
  const incumbentEpoch = h.nodeCache.instancingPublicationEpoch;
  const transformsA = makePackedTransforms(1, 1);
  const transformsB = makePackedTransforms(1, 100);
  let revisionReads = 0;
  let armed = true;
  const revisionGetter = function () {
    revisionReads++;
    if (armed && revisionReads % 4 === 0) {
      h.runtimeNode.transformsTypedArray =
        h.runtimeNode.transformsTypedArray === transformsA
          ? transformsB
          : transformsA;
    }
    return 1;
  };
  for (const transforms of [transformsA, transformsB]) {
    Object.defineProperty(transforms, "_webgpuGeometryRevision", {
      configurable: true,
      get: revisionGetter,
    });
  }
  h.runtimeNode.transformsTypedArray = transformsA;
  const createsBefore = h.device.createCalls;
  const writesBefore = h.device.queue.writeCalls;
  const candidateStart = h.device.buffers.length;

  const unstable = ensure(h);

  assert.equal(unstable, null);
  assert.equal(revisionReads, 16);
  assert.equal(h.device.createCalls - createsBefore, 4);
  assert.equal(h.device.queue.writeCalls - writesBefore, 4);
  const failedCandidates = h.device.buffers.slice(candidateStart);
  assert.equal(failedCandidates.length, 4);
  assert.ok(failedCandidates.every((buffer) => buffer.destroyCalls === 1));
  assert.equal(h.nodeCache.instancingResources, incumbent);
  assert.equal(h.nodeCache.instancingBuffer, incumbent.storageBuffer);
  assert.equal(h.nodeCache.instancingProvenance, incumbentProvenance);
  assert.equal(h.nodeCache.instancingPublicationEpoch, incumbentEpoch);
  assert.equal(incumbent.storageBuffer.destroyCalls, 0);
  assert.equal(h.nodeCache.retiredInstancingBuffers, undefined);
  assert.equal(h.context.callbacks.length, 0);
  assert.equal(h.device.queue.completions.length, 0);
  assert.equal(h.nodeCache.instancingProvenanceScratchDepth, 0);
  assert.equal(h.nodeCache.instancingConvergenceDepth, undefined);
  assert.equal(h.nodeCache.instancingConvergenceRemaining, undefined);

  armed = false;
  revisionReads = 0;
  const recoveryCreates = h.device.createCalls;
  const recoveryWrites = h.device.queue.writeCalls;
  const recovered = ensure(h);

  assert.equal(revisionReads, 6);
  assert.equal(h.device.createCalls - recoveryCreates, 1);
  assert.equal(h.device.queue.writeCalls - recoveryWrites, 1);
  assert.equal(h.nodeCache.instancingResources, recovered);
  assert.equal(h.nodeCache.instancingPublicationEpoch, incumbentEpoch + 1);
  assert.deepEqual(translationXs(recovered.storageBuffer, 1), [1]);
  assert.equal(recovered.storageBuffer.destroyCalls, 0);
  assert.ok(failedCandidates.every((buffer) => buffer.destroyCalls === 1));
  assert.equal(incumbent.storageBuffer.destroyCalls, 0);
  assert.equal(h.nodeCache.retiredInstancingBuffers.size, 1);
  assert.equal(
    h.nodeCache.retiredInstancingBuffers.has(incumbent.storageBuffer),
    true,
  );
  assert.equal(h.context.callbacks.length, 0);
  assert.equal(h.device.queue.completions.length, 0);
  assert.equal(h.nodeCache.instancingProvenanceScratchDepth, 0);
  assert.equal(h.nodeCache.instancingConvergenceDepth, undefined);
  assert.equal(h.nodeCache.instancingConvergenceRemaining, undefined);
});

test("nested ensure calls share the outer convergence budget", () => {
  const h = makeHarness(2);
  const transforms = makePackedTransforms(2, 4);
  let getterCalls = 0;
  Object.defineProperty(transforms, "_webgpuGeometryRevision", {
    get() {
      getterCalls++;
      if (getterCalls < 20) {
        ensure(h);
      }
      return 1;
    },
  });
  h.runtimeNode.transformsTypedArray = transforms;

  const result = ensure(h);

  assert.ok(result);
  assert.ok(getterCalls < 20);
  assert.equal(h.device.createCalls, 1);
  assert.equal(h.device.queue.writeCalls, 1);
  assert.equal(h.nodeCache.instancingConvergenceDepth, undefined);
  assert.equal(h.nodeCache.instancingConvergenceRemaining, undefined);
  assert.equal(h.nodeCache.instancingProvenanceScratchDepth, 0);
});

test("teardown tombstone blocks ensure re-entry from native destruction", () => {
  const h = makeHarness(2);
  const incumbent = ensure(h);
  const epochBeforeTeardown = h.nodeCache.instancingPublicationEpoch;
  let reentrantResult;
  incumbent.storageBuffer.onDestroy = function () {
    h.model.instanceFeatureIdLabel = "b";
    reentrantResult = ensure(h);
  };

  destroyInstancingResources(h.nodeCache);

  assert.equal(reentrantResult, null);
  assert.equal(h.device.createCalls, 1);
  assert.equal(h.device.queue.writeCalls, 1);
  assert.equal(incumbent.storageBuffer.destroyCalls, 1);
  assert.equal(h.nodeCache.instancingBuffer, undefined);
  assert.equal(h.nodeCache.instancingResources, undefined);
  assert.equal(h.nodeCache.instancingProvenance, undefined);
  assert.equal(h.nodeCache.instancingProvenanceScratchPool, undefined);
  assert.equal(h.nodeCache.instancingProvenanceScratchDepth, undefined);
  assert.equal(h.nodeCache.retiredInstancingBuffers, undefined);
  assert.equal(h.nodeCache.instancingResourcesDestroyed, true);
  assert.equal(h.nodeCache.instancingPublicationEpoch, epochBeforeTeardown + 1);

  const createCount = h.device.createCalls;
  destroyInstancingResources(h.nodeCache);
  assert.equal(ensure(h), null);
  assert.equal(h.device.createCalls, createCount);
  assert.equal(incumbent.storageBuffer.destroyCalls, 1);
});

test("teardown during candidate creation destroys it unpublished without retry", () => {
  const h = makeHarness(2);
  h.device.onCreateBuffer = function () {
    destroyInstancingResources(h.nodeCache);
  };

  const result = ensure(h);

  assert.equal(result, null);
  assert.equal(h.device.createCalls, 1);
  assert.equal(h.device.queue.writeCalls, 1);
  assert.equal(h.device.buffers.length, 1);
  assert.equal(h.device.buffers[0].destroyCalls, 1);
  assert.equal(h.nodeCache.instancingBuffer, undefined);
  assert.equal(h.nodeCache.instancingResources, undefined);
  assert.equal(h.nodeCache.retiredInstancingBuffers, undefined);
  assert.equal(h.nodeCache.instancingResourcesDestroyed, true);
  assert.equal(h.nodeCache.instancingPublicationEpoch, 1);

  destroyInstancingResources(h.nodeCache);
  assert.equal(ensure(h), null);
  assert.equal(h.device.createCalls, 1);
  assert.equal(h.device.buffers[0].destroyCalls, 1);
});

test("teardown during candidate upload drains incumbent and candidate exactly once", () => {
  const h = makeHarness(2);
  const incumbent = ensure(h);
  h.model.instanceFeatureIdLabel = "b";
  h.device.queue.onWriteBuffer = function () {
    destroyInstancingResources(h.nodeCache);
  };

  const result = ensure(h);

  assert.equal(result, null);
  assert.equal(h.device.createCalls, 2);
  assert.equal(h.device.queue.writeCalls, 2);
  assert.equal(h.device.buffers.length, 2);
  assert.equal(incumbent.storageBuffer.destroyCalls, 1);
  assert.equal(h.device.buffers[1].destroyCalls, 1);
  assert.equal(h.nodeCache.instancingBuffer, undefined);
  assert.equal(h.nodeCache.instancingResources, undefined);
  assert.equal(h.nodeCache.retiredInstancingBuffers, undefined);
  assert.equal(h.nodeCache.instancingResourcesDestroyed, true);
  assert.equal(h.nodeCache.instancingPublicationEpoch, 2);
  assert.equal(h.context.callbacks.length, 0);

  destroyInstancingResources(h.nodeCache);
  assert.equal(ensure(h), null);
  assert.equal(h.device.createCalls, 2);
  assert.equal(incumbent.storageBuffer.destroyCalls, 1);
  assert.equal(h.device.buffers[1].destroyCalls, 1);
});

test("failed enlistment retries on a stable frame without reallocating", async () => {
  const h = makeHarness();
  const first = ensure(h);
  h.model.instanceFeatureIdLabel = "b";
  h.context.accepted = false;
  const replacement = ensure(h);

  assert.notEqual(replacement.storageBuffer, first.storageBuffer);
  assert.equal(
    h.nodeCache.retiredInstancingBuffers.has(first.storageBuffer),
    true,
  );
  assert.equal(first.storageBuffer.destroyCalls, 0);
  const createCount = h.device.createCalls;

  h.context.throwOnEnqueue = true;
  const throwingRetry = ensure(h);
  assert.equal(throwingRetry.storageBuffer, replacement.storageBuffer);
  assert.equal(h.device.createCalls, createCount);
  assert.equal(
    h.nodeCache.retiredInstancingBuffers.has(first.storageBuffer),
    true,
  );

  h.context.throwOnEnqueue = false;
  h.context.accepted = true;
  h.context.currentCommandEncoder = { label: "encoder-b" };
  const acceptedRetry = ensure(h);
  assert.equal(acceptedRetry.storageBuffer, replacement.storageBuffer);
  assert.equal(h.device.createCalls, createCount);
  assert.equal(h.nodeCache.retiredInstancingBuffers, undefined);
  assert.equal(h.context.callbacks[0].encoder.label, "encoder-b");

  const pinnedQueue = h.device.queue;
  h.device.queue = new FakeQueue();
  const entry = h.context.callbacks.shift();
  entry.callback(false);
  assert.equal(pinnedQueue.completions.length, 1);
  assert.equal(h.device.queue.completions.length, 0);
  assert.equal(first.storageBuffer.destroyCalls, 0);
  pinnedQueue.resolveNext();
  await flushPromises();
  assert.equal(first.storageBuffer.destroyCalls, 1);
});

test("foreign retirement mutation is revalidated after stable and publish paths", () => {
  for (const boundary of ["stable", "publish"]) {
    const h = makeHarness(2);
    ensure(h);
    h.model.instanceFeatureIdLabel = "b";

    if (boundary === "stable") {
      h.context.accepted = false;
      ensure(h);
      h.context.accepted = true;
    }

    let mutateOnce = true;
    h.context.enqueueAfterCommandEncoderSubmit = function (encoder, callback) {
      h.context.callbacks.push({ encoder, callback });
      if (mutateOnce) {
        mutateOnce = false;
        h.model.instanceFeatureIdLabel = "a";
      }
      return true;
    };

    const result = ensure(h);

    assert.equal(h.model.instanceFeatureIdLabel, "a", boundary);
    assert.deepEqual(featureIds(result.storageBuffer, 2), [1, 2], boundary);
    assert.equal(h.nodeCache.instancingResources, result, boundary);
    assert.equal(h.nodeCache.instancingBuffer, result.storageBuffer, boundary);
    assert.equal(h.device.createCalls, 3, boundary);
    assert.equal(h.device.queue.writeCalls, 3, boundary);
    assert.equal(h.context.callbacks.length, 2, boundary);

    const createCount = h.device.createCalls;
    assert.equal(ensure(h), result, boundary);
    assert.equal(h.device.createCalls, createCount, boundary);
  }
});

test("GPU-settlement rejection drops the scheduled owner without native destruction", async () => {
  const h = makeHarness();
  const first = ensure(h);
  h.model.instanceFeatureIdLabel = "b";
  ensure(h);

  const entry = h.context.callbacks.shift();
  entry.callback(true);
  assert.equal(first.storageBuffer.destroyCalls, 0);
  h.device.queue.rejectNext();
  await flushPromises();
  assert.equal(first.storageBuffer.destroyCalls, 0);
  assert.equal(h.nodeCache.retiredInstancingBuffers, undefined);
});

test("retirement reserves ownership before enqueue can trigger teardown", async () => {
  const h = makeHarness(2);
  const first = ensure(h);
  h.model.instanceFeatureIdLabel = "b";
  h.context.enqueueAfterCommandEncoderSubmit = function (encoder, callback) {
    h.context.callbacks.push({ encoder, callback });
    callback(false);
    destroyInstancingResources(h.nodeCache);
    return true;
  };

  const result = ensure(h);
  const replacement = h.device.buffers[1];

  assert.equal(result, null);
  assert.equal(h.nodeCache.instancingResourcesDestroyed, true);
  assert.equal(first.storageBuffer.destroyCalls, 0);
  assert.equal(replacement.destroyCalls, 1);
  assert.equal(h.context.callbacks.length, 1);
  assert.equal(h.device.queue.completions.length, 1);

  const entry = h.context.callbacks.shift();
  h.device.queue.resolveNext();
  await flushPromises();
  assert.equal(first.storageBuffer.destroyCalls, 1);
  assert.equal(replacement.destroyCalls, 1);

  entry.callback(false);
  assert.equal(h.device.queue.completions.length, 0);
  destroyInstancingResources(h.nodeCache);
  assert.equal(first.storageBuffer.destroyCalls, 1);
  assert.equal(replacement.destroyCalls, 1);
});

test("failed retirement transfer drains its reservation after terminal teardown", () => {
  for (const mode of ["false", "throw"]) {
    const h = makeHarness(2);
    const first = ensure(h);
    h.model.instanceFeatureIdLabel = "b";
    let rejectedCallback;
    h.context.enqueueAfterCommandEncoderSubmit = function (...args) {
      const callback = args[1];
      rejectedCallback = callback;
      callback(false);
      destroyInstancingResources(h.nodeCache);
      if (mode === "throw") {
        throw new Error("enlistment failed after teardown");
      }
      return false;
    };

    const result = ensure(h);
    const replacement = h.device.buffers[1];

    assert.equal(result, null, mode);
    assert.equal(h.nodeCache.instancingResourcesDestroyed, true, mode);
    assert.equal(first.storageBuffer.destroyCalls, 1, mode);
    assert.equal(replacement.destroyCalls, 1, mode);
    assert.equal(h.context.callbacks.length, 0, mode);
    assert.equal(h.device.queue.completions.length, 0, mode);
    rejectedCallback(false);
    assert.equal(h.device.queue.completions.length, 0, mode);
    destroyInstancingResources(h.nodeCache);
    assert.equal(first.storageBuffer.destroyCalls, 1, mode);
    assert.equal(replacement.destroyCalls, 1, mode);
  }
});

test("teardown detaches, deduplicates, continues after errors, and is idempotent", () => {
  const h = makeHarness();
  h.context.accepted = false;
  const first = ensure(h);
  h.model.instanceFeatureIdLabel = "b";
  const current = ensure(h);

  h.nodeCache.retiredInstancingBuffers.add(current.storageBuffer);
  first.storageBuffer.throwOnDestroy = true;
  assert.throws(
    () => destroyInstancingResources(h.nodeCache),
    /destroy failed/,
  );
  assert.equal(first.storageBuffer.destroyCalls, 1);
  assert.equal(current.storageBuffer.destroyCalls, 1);
  assert.equal(h.nodeCache.instancingBuffer, undefined);
  assert.equal(h.nodeCache.instancingProvenance, undefined);
  assert.equal(h.nodeCache.retiredInstancingBuffers, undefined);

  destroyInstancingResources(h.nodeCache);
  assert.equal(first.storageBuffer.destroyCalls, 1);
  assert.equal(current.storageBuffer.destroyCalls, 1);
});

test("scheduler-owned and node-owned generations are never destroyed twice", async () => {
  const h = makeHarness();
  const first = ensure(h);
  h.model.instanceFeatureIdLabel = "b";
  const current = ensure(h);

  assert.equal(h.nodeCache.retiredInstancingBuffers, undefined);
  destroyInstancingResources(h.nodeCache);
  assert.equal(current.storageBuffer.destroyCalls, 1);
  assert.equal(first.storageBuffer.destroyCalls, 0);

  const entry = h.context.callbacks.shift();
  entry.callback(false);
  h.device.queue.resolveNext();
  await flushPromises();
  assert.equal(first.storageBuffer.destroyCalls, 1);

  destroyInstancingResources(h.nodeCache);
  assert.equal(current.storageBuffer.destroyCalls, 1);
  assert.equal(first.storageBuffer.destroyCalls, 1);
});

test("renderer keeps capture publication, fail-closed instancing, context, and shadow ordering", async () => {
  const rendererPath = resolve(
    ENGINE_SOURCE,
    "Renderer/WebGPU/WebGPUModelRenderer.ts",
  );
  const source = await readFile(rendererPath, "utf8");

  function assertRendererContract(candidate) {
    const captureUpsert = candidate.indexOf(
      "upsertModelCapturePublishEntry(pub.models, capturePublishEntry)",
    );
    const nodeLoop = candidate.indexOf(
      "for (let nodeIdx = 0; nodeIdx < runtimeNodes.length; nodeIdx++)",
      captureUpsert,
    );
    const instancingBranchStart = candidate.indexOf(
      "if (hasInstancing && !pipelineWarmupOnly) {",
      nodeLoop,
    );
    const instancingCall = candidate.indexOf(
      "const instRes = ensureInstancingResources(",
      instancingBranchStart,
    );
    const cameraBoundary = candidate.indexOf(
      "// Camera resources are realized",
      instancingCall,
    );
    const instancingBranch = candidate.slice(
      instancingBranchStart,
      cameraBoundary,
    );
    const nullGuard = candidate.indexOf(
      "if (!defined(instRes))",
      instancingCall,
    );
    const primitiveLoop = candidate.indexOf(
      "for (let primIdx = 0; primIdx < prims.length; primIdx++)",
      instancingCall,
    );
    const mergedInstance = candidate.indexOf(
      "getOrCreateMergedInstanceBindGroup(",
      primitiveLoop,
    );
    const capturePush = candidate.indexOf(
      "captureRecords.push({",
      primitiveLoop,
    );
    const shadowLayout = candidate.indexOf(
      "getModelShadowCastLayout(",
      primitiveLoop,
    );
    const commandPush = candidate.indexOf(
      "commandList.push(webgpuCmd)",
      primitiveLoop,
    );

    assert.ok(captureUpsert >= 0);
    assert.ok(nodeLoop > captureUpsert);
    assert.ok(instancingBranchStart > nodeLoop);
    assert.ok(instancingCall > instancingBranchStart);
    assert.ok(cameraBoundary > instancingCall);
    assert.match(
      instancingBranch,
      /if \(hasInstancing && !pipelineWarmupOnly\) \{[\s\S]*?if \(!defined\(instRes\)\) \{[\s\S]*?continue;[\s\S]*?\}\s*instanceCount = instRes\.instanceCount;\s*instanceBuffer = instRes\.storageBuffer;/,
    );
    assert.ok(nullGuard > instancingCall);
    assert.ok(nullGuard < cameraBoundary);
    assert.ok(primitiveLoop > nullGuard);
    assert.ok(mergedInstance > nullGuard);
    assert.ok(capturePush > nullGuard);
    assert.equal(candidate.indexOf("captureRecords.push({"), capturePush);
    assert.ok(shadowLayout > nullGuard);
    assert.ok(commandPush > nullGuard);
    assert.match(
      candidate.slice(instancingCall, instancingCall + 650),
      /Parameters<typeof ensureInstancingResources>\[4\]/,
    );
    assert.match(
      candidate,
      /_shadowCastInstancingSB = nodeCache\.instancingBuffer;/,
    );
  }

  assertRendererContract(source);
  const missingContinueMutant = replaceOnce(
    source,
    /(if \(!defined\(instRes\)\) \{[\s\S]*?)continue;/,
    "$1instanceCount = 1;",
    "renderer continue mutant must alter the source",
  );
  const inertNullGuardMutant = replaceOnce(
    source,
    "if (!defined(instRes)) {",
    "if (false && !defined(instRes)) {",
    "renderer null-guard mutant must alter the source",
  );
  const missingWarmupGuardMutant = replaceOnce(
    source,
    "if (hasInstancing && !pipelineWarmupOnly) {",
    "if (hasInstancing) {",
    "renderer warmup-guard mutant must alter the source",
  );
  const missingInstancingGuardMutant = replaceOnce(
    source,
    "if (hasInstancing && !pipelineWarmupOnly) {",
    "if (!pipelineWarmupOnly) {",
    "renderer instancing-guard mutant must alter the source",
  );
  for (const [label, mutant] of [
    ["missing continue", missingContinueMutant],
    ["inert null guard", inertNullGuardMutant],
    ["missing warmup guard", missingWarmupGuardMutant],
    ["missing instancing guard", missingInstancingGuardMutant],
  ]) {
    assert.throws(
      () => assertRendererContract(mutant),
      isAssertionError,
      `${label} must fail the renderer contract`,
    );
  }
});
