// @purpose Drives the real WebGPUCloudShadowBindGroupCache on a fake device: per-slot dedupe, descriptor identity, invalidation on resource change.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(
  here,
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudShadowBindGroupCache.ts",
);
const { code } = await transform(fs.readFileSync(sourcePath, "utf8"), {
  loader: "ts",
  format: "esm",
  target: "es2022",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const { createCloudShadowBindGroupCache, getOrCreateCloudShadowBindGroup } =
  await import(moduleUrl);

function createHarness() {
  const descriptors = [];
  const device = {
    createBindGroup(descriptor) {
      const bindGroup = { id: descriptors.length + 1, descriptor };
      descriptors.push(descriptor);
      return bindGroup;
    },
  };
  const resources = {
    layout: {},
    cloudUniformBuffer: {},
    weatherView: {},
    weatherSampler: {},
    shapeView: {},
    detailView: {},
    noiseSampler: {},
    shadowUniformBuffer: {},
  };
  return {
    cache: createCloudShadowBindGroupCache(),
    descriptors,
    device,
    resources,
  };
}

function resolve(harness, slot = 0, offset = 0, size = 80) {
  const r = harness.resources;
  return getOrCreateCloudShadowBindGroup(
    harness.device,
    harness.cache,
    slot,
    r.layout,
    r.cloudUniformBuffer,
    r.weatherView,
    r.weatherSampler,
    r.shapeView,
    r.detailView,
    r.noiseSampler,
    r.shadowUniformBuffer,
    offset,
    size,
    r.materialFlowBuffer,
  );
}

test("unchanged single-map resources reuse one bind group", () => {
  const harness = createHarness();
  const first = resolve(harness);
  const second = resolve(harness);
  assert.equal(second, first);
  assert.equal(harness.descriptors.length, 1);

  const shadowResource = harness.descriptors[0].entries.find(
    (entry) => entry.binding === 13,
  ).resource;
  assert.deepEqual(shadowResource, {
    buffer: harness.resources.shadowUniformBuffer,
    offset: 0,
    size: 80,
  });
});

test("the three cascade offsets occupy stable independent cache slots", () => {
  const harness = createHarness();
  const groups = [
    resolve(harness, 1, 0, 80),
    resolve(harness, 2, 256, 80),
    resolve(harness, 3, 512, 80),
  ];
  assert.equal(harness.descriptors.length, 3);
  assert.deepEqual(
    harness.descriptors.map(
      (descriptor) =>
        descriptor.entries.find((entry) => entry.binding === 13).resource
          .offset,
    ),
    [0, 256, 512],
  );
  assert.equal(resolve(harness, 1, 0, 80), groups[0]);
  assert.equal(resolve(harness, 2, 256, 80), groups[1]);
  assert.equal(resolve(harness, 3, 512, 80), groups[2]);
  assert.equal(harness.descriptors.length, 3);
});

test("a changed resource invalidates only the selected slot", () => {
  const harness = createHarness();
  const single = resolve(harness, 0, 0, 80);
  const cascade = resolve(harness, 1, 0, 80);
  harness.resources.weatherView = {};

  assert.notEqual(resolve(harness, 0, 0, 80), single);
  assert.equal(harness.descriptors.length, 3);
  assert.notEqual(resolve(harness, 1, 0, 80), cascade);
  assert.equal(harness.descriptors.length, 4);
});

test("shadow flow resource identity is bound and invalidates cached groups", () => {
  const harness = createHarness();
  harness.resources.materialFlowBuffer = {};
  const first = resolve(harness);
  assert.equal(resolve(harness), first);
  assert.equal(
    first.descriptor.entries.find((entry) => entry.binding === 15).resource
      .buffer,
    harness.resources.materialFlowBuffer,
  );
  harness.resources.materialFlowBuffer = {};
  assert.notEqual(resolve(harness), first);
});

test("shadow maps retain exact previous-weather bindings and invalidate only the changed epoch", () => {
  const h = createHarness(),
    r = h.resources;
  r.materialFlowBuffer = {};
  const current = { weatherView: {}, materialFlowBuffer: {} };
  const resolvePair = (pair) =>
    getOrCreateCloudShadowBindGroup(
      h.device,
      h.cache,
      0,
      r.layout,
      r.cloudUniformBuffer,
      r.weatherView,
      r.weatherSampler,
      r.shapeView,
      r.detailView,
      r.noiseSampler,
      r.shadowUniformBuffer,
      0,
      80,
      r.materialFlowBuffer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pair,
    );
  const first = resolvePair(current);
  assert.equal(
    first.descriptor.entries.find((x) => x.binding === 29).resource,
    current.weatherView,
  );
  assert.equal(
    first.descriptor.entries.find((x) => x.binding === 30).resource.buffer,
    current.materialFlowBuffer,
  );
  assert.equal(resolvePair(current), first);
  assert.notEqual(resolvePair({ ...current, materialFlowBuffer: {} }), first);
});

// Every compared input, with every optional family present, changed alone.
function createFullInputs() {
  return {
    layout: { label: "layout" },
    cloudUniformBuffer: { label: "cloud uniform" },
    weatherView: { label: "weather view" },
    weatherSampler: { label: "weather sampler" },
    shapeView: { label: "shape view" },
    detailView: { label: "detail view" },
    noiseSampler: { label: "noise sampler" },
    shadowUniformBuffer: { label: "shadow uniform" },
    shadowUniformOffset: 256,
    shadowUniformSize: 80,
    materialFlowBuffer: { label: "material flow" },
    occupancyView: { label: "occupancy view" },
    occupancyUniformBuffer: { label: "occupancy uniform" },
    densityCacheView: { label: "density cache view" },
    densityCacheUniform: { label: "density cache uniform" },
    deepShadowView: { label: "deep shadow view" },
    deepShadowUniform: { label: "deep shadow uniform" },
    weatherTransition: {
      weatherView: { label: "transition weather" },
      materialFlowBuffer: { label: "transition material flow" },
    },
  };
}

function resolveFull(harness, inputs, slot = 0) {
  return getOrCreateCloudShadowBindGroup(
    harness.device,
    harness.cache,
    slot,
    inputs.layout,
    inputs.cloudUniformBuffer,
    inputs.weatherView,
    inputs.weatherSampler,
    inputs.shapeView,
    inputs.detailView,
    inputs.noiseSampler,
    inputs.shadowUniformBuffer,
    inputs.shadowUniformOffset,
    inputs.shadowUniformSize,
    inputs.materialFlowBuffer,
    inputs.occupancyView,
    inputs.occupancyUniformBuffer,
    inputs.densityCacheView,
    inputs.densityCacheUniform,
    inputs.deepShadowView,
    inputs.deepShadowUniform,
    inputs.weatherTransition,
  );
}

const resourceAt = (bindGroup, binding) =>
  bindGroup.descriptor.entries.find((entry) => entry.binding === binding)
    ?.resource;
const asView = (resource) => resource;
const asBuffer = (resource) => resource?.buffer;
const asOffset = (resource) => resource?.offset;
const asSize = (resource) => resource?.size;
const whole = (value) => value;

// field -> how a replacement is made and which bindings must carry it.
// carry entries: [binding, read from the bound resource, read from the replacement].
const GUARD_CASES = {
  layout: { make: () => ({ label: "new layout" }), carry: [] },
  cloudUniformBuffer: {
    make: () => ({ label: "new cloud uniform" }),
    carry: [[3, asBuffer, whole]],
  },
  weatherView: {
    make: () => ({ label: "new weather view" }),
    carry: [[4, asView, whole]],
  },
  weatherSampler: {
    make: () => ({ label: "new weather sampler" }),
    carry: [[5, asView, whole]],
  },
  shapeView: {
    make: () => ({ label: "new shape view" }),
    carry: [[6, asView, whole]],
  },
  detailView: {
    make: () => ({ label: "new detail view" }),
    carry: [[7, asView, whole]],
  },
  noiseSampler: {
    make: () => ({ label: "new noise sampler" }),
    carry: [[8, asView, whole]],
  },
  shadowUniformBuffer: {
    make: () => ({ label: "new shadow uniform" }),
    carry: [[13, asBuffer, whole]],
  },
  shadowUniformOffset: { make: () => 512, carry: [[13, asOffset, whole]] },
  shadowUniformSize: { make: () => 96, carry: [[13, asSize, whole]] },
  materialFlowBuffer: {
    make: () => ({ label: "new material flow" }),
    carry: [[15, asBuffer, whole]],
  },
  weatherTransition: {
    make: () => ({
      weatherView: { label: "new transition weather" },
      materialFlowBuffer: { label: "new transition material flow" },
    }),
    carry: [
      [29, asView, (pair) => pair.weatherView],
      [30, asBuffer, (pair) => pair.materialFlowBuffer],
    ],
  },
  occupancyView: {
    make: () => ({ label: "new occupancy view" }),
    carry: [[17, asView, whole]],
  },
  occupancyUniformBuffer: {
    make: () => ({ label: "new occupancy uniform" }),
    carry: [[18, asBuffer, whole]],
  },
  densityCacheView: {
    make: () => ({ label: "new density cache view" }),
    carry: [[20, asView, whole]],
  },
  densityCacheUniform: {
    make: () => ({ label: "new density cache uniform" }),
    carry: [[21, asBuffer, whole]],
  },
  deepShadowView: {
    make: () => ({ label: "new deep shadow view" }),
    carry: [[22, asView, whole]],
  },
  deepShadowUniform: {
    make: () => ({ label: "new deep shadow uniform" }),
    carry: [[23, asBuffer, whole]],
  },
};

test("identical inputs with every optional family present reuse one bind group", () => {
  const harness = createHarness();
  const inputs = createFullInputs();
  const first = resolveFull(harness, inputs);
  assert.equal(resolveFull(harness, inputs), first);
  assert.equal(harness.descriptors.length, 1);
  assert.equal(first.descriptor.layout, inputs.layout);
});

for (const [field, guard] of Object.entries(GUARD_CASES)) {
  test(`a changed ${field} alone gives a new bind group carrying it`, () => {
    const harness = createHarness();
    const inputs = createFullInputs();
    const before = resolveFull(harness, inputs);

    const replacement = guard.make();
    inputs[field] = replacement;
    const after = resolveFull(harness, inputs);

    assert.notEqual(after, before, `${field} change must not reuse`);
    assert.equal(harness.descriptors.length, 2, `${field} creates one group`);
    assert.equal(
      harness.cache[0][field],
      replacement,
      `${field} is stored in the cache entry`,
    );
    if (field === "layout") {
      assert.equal(after.descriptor.layout, replacement);
    }
    for (const [binding, readBound, readReplacement] of guard.carry) {
      assert.deepEqual(
        readBound(resourceAt(after, binding)),
        readReplacement(replacement),
        `${field} is carried at binding ${binding}`,
      );
    }
    assert.equal(resolveFull(harness, inputs), after, `${field} reuses again`);
  });
}

test("without a weatherTransition the bindings 29 and 30 fall back to the current weather and flow", () => {
  const harness = createHarness();
  const inputs = createFullInputs();
  inputs.weatherTransition = undefined;
  const bindGroup = resolveFull(harness, inputs);
  assert.equal(resourceAt(bindGroup, 29), inputs.weatherView);
  assert.equal(resourceAt(bindGroup, 30).buffer, inputs.materialFlowBuffer);
});

test("every field the cache entry stores and every binding created has a guarding case", () => {
  const harness = createHarness();
  const bindGroup = resolveFull(harness, createFullInputs());
  const stored = Object.keys(harness.cache[0]).filter(
    (name) => name !== "bindGroup",
  );
  const unguardedFields = stored.filter((name) => !(name in GUARD_CASES));
  assert.deepEqual(
    unguardedFields,
    [],
    `cache entry fields with no guarding case: ${unguardedFields.join(", ")}`,
  );
  const staleFields = Object.keys(GUARD_CASES).filter(
    (name) => !stored.includes(name),
  );
  assert.deepEqual(
    staleFields,
    [],
    `guarding cases for fields the cache entry no longer stores: ${staleFields.join(", ")}`,
  );

  const guardedBindings = new Set(
    Object.values(GUARD_CASES).flatMap((guard) =>
      guard.carry.map((carried) => carried[0]),
    ),
  );
  const created = bindGroup.descriptor.entries.map((entry) => entry.binding);
  const unguardedBindings = created.filter(
    (binding) => !guardedBindings.has(binding),
  );
  assert.deepEqual(
    unguardedBindings,
    [],
    `descriptor bindings with no guarding case: ${unguardedBindings.join(", ")}`,
  );
  const staleBindings = [...guardedBindings].filter(
    (binding) => !created.includes(binding),
  );
  assert.deepEqual(
    staleBindings,
    [],
    `guarding cases for bindings the descriptor no longer creates: ${staleBindings.join(", ")}`,
  );
});
