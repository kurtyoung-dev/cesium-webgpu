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
