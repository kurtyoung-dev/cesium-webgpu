// bind-group-layout-census.spec.mjs - the live bind-group-layout census, run as the page runs it.
//
// @purpose Node spec for lib/bind-group-layout-census.mjs: the real init source runs against fake GPUDevice classes installed on a fake page's global, and asserts the per-stage counts by kind (an entry visible to two stages counted in both), the group index taken from the pipeline layout, a label never created reading seen: false, the rows against the WebGPU default and the device's own limits, the summary line, and the pass-through of the original calls, with inertness mutants for the stage-bit decoding and the group-index recording.
// @status ACTIVE
//
// The census is a page init script, so it is run here the way a page runs it:
// its source text evaluated in a fresh `vm` context whose global carries the
// fake `GPUDevice`. Nothing is read from engine source; the descriptors are the
// ones this spec writes, and the expected counts are worked by hand beside them.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE,
  LAYOUT_KINDS,
  layoutCensusLine,
  layoutCensusRows,
  pageReadBindGroupLayoutCensus,
  readBindGroupLayoutCensus,
} from "./lib/bind-group-layout-census.mjs";
import { WEBGPU_DEFAULT_LIMITS } from "./lib/device-limits-dial.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

const CENSUS_MODULE = fileURLToPath(
  new URL("./lib/bind-group-layout-census.mjs", import.meta.url),
);

const VERTEX = 1;
const FRAGMENT = 2;
const COMPUTE = 4;

/** A fake page: a vm context whose global carries a fake GPUDevice. */
function makePage({
  source = BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE,
  limits,
} = {}) {
  const context = vm.createContext({});
  vm.runInContext(
    `
    globalThis.__received = [];
    globalThis.GPUDevice = class GPUDevice {
      createBindGroupLayout(descriptor) {
        globalThis.__received.push(["bgl", this === globalThis.__device, descriptor]);
        return { kind: "bgl", label: descriptor && descriptor.label };
      }
      createPipelineLayout(descriptor) {
        globalThis.__received.push(["pl", this === globalThis.__device, descriptor]);
        return { kind: "pl" };
      }
    };
    globalThis.__device = new GPUDevice();
    `,
    context,
  );
  if (limits !== undefined) {
    vm.runInContext(
      `globalThis.viewer = { scene: { context: { device: { limits: ${JSON.stringify(limits)} } } } };`,
      context,
    );
  }
  vm.runInContext(source, context);
  return {
    context,
    device: vm.runInContext("globalThis.__device", context),
    run(code) {
      return vm.runInContext(code, context);
    },
    /** Page functions run in the context, their answer cloned out of it. */
    async evaluate(fn, arg) {
      const f = vm.runInContext(`(${fn.toString()})`, context);
      return JSON.parse(JSON.stringify(await f(arg)));
    },
  };
}

/** Layout `name`: one entry per line below, with the counts worked out. */
const MARCH_ENTRIES = [
  // vertex + fragment uniform buffer: counted in vertex and fragment.
  { binding: 0, visibility: VERTEX | FRAGMENT, buffer: { type: "uniform" } },
  // no type: a uniform buffer.
  { binding: 1, visibility: FRAGMENT, buffer: {} },
  // three sampled textures in the fragment stage, one of them also in compute.
  { binding: 2, visibility: FRAGMENT, texture: { sampleType: "float" } },
  { binding: 3, visibility: FRAGMENT, texture: { sampleType: "float" } },
  {
    binding: 4,
    visibility: FRAGMENT | COMPUTE,
    texture: { viewDimension: "3d" },
  },
  { binding: 5, visibility: FRAGMENT, sampler: { type: "filtering" } },
  { binding: 6, visibility: COMPUTE, buffer: { type: "storage" } },
  { binding: 7, visibility: COMPUTE, buffer: { type: "read-only-storage" } },
  {
    binding: 8,
    visibility: COMPUTE,
    storageTexture: { access: "write-only", format: "rgba8unorm" },
  },
  { binding: 9, visibility: FRAGMENT, externalTexture: {} },
];

const MARCH_COUNTS = {
  vertex: {
    sampledTextures: 0,
    uniformBuffers: 1,
    storageBuffers: 0,
    samplers: 0,
    storageTextures: 0,
    externalTextures: 0,
  },
  fragment: {
    sampledTextures: 3,
    uniformBuffers: 2,
    storageBuffers: 0,
    samplers: 1,
    storageTextures: 0,
    externalTextures: 1,
  },
  compute: {
    sampledTextures: 1,
    uniformBuffers: 0,
    storageBuffers: 2,
    samplers: 0,
    storageTextures: 1,
    externalTextures: 0,
  },
};

const LABELS = ["March BGL", "Shadow BGL", "Never BGL"];

function drivePage(page) {
  page.run(`
    const march = __device.createBindGroupLayout({
      label: "March BGL",
      entries: ${JSON.stringify(MARCH_ENTRIES)},
    });
    const shadow = __device.createBindGroupLayout({
      label: "Shadow BGL",
      entries: [{ binding: 0, visibility: ${FRAGMENT}, texture: {} }],
    });
    __device.createBindGroupLayout({ entries: [{ binding: 0, visibility: ${FRAGMENT}, buffer: {} }] });
    __device.createPipelineLayout({ label: "one", bindGroupLayouts: [shadow, march] });
    __device.createPipelineLayout({ label: "two", bindGroupLayouts: [march] });
  `);
}

const rawOf = (page) =>
  page.evaluate(pageReadBindGroupLayoutCensus, {
    keys: Object.values(LAYOUT_KINDS).filter((key) => key !== null),
  });

test("the census counts, per stage and kind, the entries visible to each stage, an entry visible to two stages in both", async () => {
  const page = makePage();
  drivePage(page);
  const raw = await rawOf(page);
  assert.equal(raw.installed, true);
  assert.deepEqual(raw.layouts["March BGL"].counts, MARCH_COUNTS);
  assert.equal(raw.layouts["March BGL"].created, 1);
  assert.equal(raw.layouts["March BGL"].entries, MARCH_ENTRIES.length);
  // The layout without a label is counted apart, never under a label.
  assert.equal(raw.unlabelled, 1);
  assert.deepEqual(Object.keys(raw.layouts).sort(), [
    "March BGL",
    "Shadow BGL",
  ]);
});

test("the group index is the position the layout takes in a pipeline layout, counted per pipeline layout", async () => {
  const page = makePage();
  drivePage(page);
  const raw = await rawOf(page);
  // march: position 1 in "one", position 0 in "two"; shadow: position 0 in "one".
  assert.deepEqual(raw.groups["March BGL"], { 0: 1, 1: 1 });
  assert.deepEqual(raw.groups["Shadow BGL"], { 0: 1 });
  const rows = layoutCensusRows(raw, LABELS);
  assert.deepEqual(rows[0].groups, [0, 1]);
  assert.deepEqual(rows[1].groups, [0]);
});

test("a label never created reads seen: false with no counts, and the others read seen", async () => {
  const page = makePage();
  drivePage(page);
  const rows = layoutCensusRows(await rawOf(page), LABELS);
  assert.deepEqual(
    rows.map((row) => [row.label, row.seen]),
    [
      ["March BGL", true],
      ["Shadow BGL", true],
      ["Never BGL", false],
    ],
  );
  assert.equal(rows[2].counts, null);
  assert.deepEqual(rows[2].groups, []);
  assert.match(layoutCensusLine(rows[2]), /`Never BGL`: not created/u);
});

test("the original calls get the descriptor and the device as they were, and their layouts come back", () => {
  const page = makePage();
  const returned = page.run(`
    const descriptor = { label: "Echo BGL", entries: [] };
    const layout = __device.createBindGroupLayout(descriptor);
    [layout.kind, layout.label, __received[0][1], __received[0][2] === descriptor];
  `);
  assert.deepEqual(Array.from(returned), ["bgl", "Echo BGL", true, true]);
});

test("a label created twice keeps the largest counts and says how many creations and shapes", async () => {
  const page = makePage();
  page.run(`
    __device.createBindGroupLayout({ label: "Twice", entries: [
      { binding: 0, visibility: ${FRAGMENT}, texture: {} }] });
    __device.createBindGroupLayout({ label: "Twice", entries: [
      { binding: 0, visibility: ${FRAGMENT}, texture: {} },
      { binding: 1, visibility: ${FRAGMENT}, texture: {} }] });
    __device.createBindGroupLayout({ label: "Twice", entries: [
      { binding: 0, visibility: ${FRAGMENT}, texture: {} }] });
  `);
  const [row] = layoutCensusRows(await rawOf(page), ["Twice"]);
  assert.equal(row.created, 3);
  assert.equal(row.variants, 2);
  assert.equal(row.counts.fragment.sampledTextures, 2);
});

test("the rows set each count against the WebGPU defaults and the device's own limits", async () => {
  const sampled = (n) =>
    Array.from({ length: n }, (_, binding) => ({
      binding,
      visibility: FRAGMENT,
      texture: {},
    }));
  const drive = (page) =>
    page.run(`
      __device.createBindGroupLayout({ label: "Wide", entries: ${JSON.stringify(sampled(17))} });
    `);

  // A device that raised the limit: above the default, within the device's.
  const raised = makePage({
    limits: { maxSampledTexturesPerShaderStage: 32 },
  });
  drive(raised);
  const [wide] = layoutCensusRows(await rawOf(raised), ["Wide"]);
  assert.deepEqual(wide.overDefault, ["fragment.sampledTextures"]);
  assert.deepEqual(wide.overDevice, []);
  assert.deepEqual(wide.limits.sampledTextures, { default: 16, device: 32 });
  assert.match(
    layoutCensusLine(wide),
    /fragment sampledTextures 17\/16, device 32/u,
  );
  assert.match(
    layoutCensusLine(wide),
    /above the default limit: fragment\.sampledTextures/u,
  );

  // A default-limits device: above both.
  const plain = makePage({
    limits: { maxSampledTexturesPerShaderStage: 16 },
  });
  drive(plain);
  const [over] = layoutCensusRows(await rawOf(plain), ["Wide"]);
  assert.deepEqual(over.overDevice, ["fragment.sampledTextures"]);

  // No viewer: the device's limit is unknown, never guessed.
  const none = makePage();
  drive(none);
  const [unknown] = layoutCensusRows(await rawOf(none), ["Wide"]);
  assert.equal(unknown.limits.sampledTextures.device, null);
  assert.deepEqual(unknown.overDevice, []);
  assert.deepEqual(unknown.overDefault, ["fragment.sampledTextures"]);
});

test("the default limits the rows read are the specification's per-stage defaults", () => {
  const defaults = Object.fromEntries(
    Object.entries(LAYOUT_KINDS)
      .filter(([, key]) => key !== null)
      .map(([kind, key]) => [kind, WEBGPU_DEFAULT_LIMITS[key]]),
  );
  assert.deepEqual(defaults, {
    sampledTextures: 16,
    uniformBuffers: 12,
    storageBuffers: 8,
    samplers: 16,
    storageTextures: 4,
  });
});

test("the summary line names the label, the group and the non-zero per-stage counts against the defaults", async () => {
  const page = makePage();
  drivePage(page);
  const [march] = layoutCensusRows(await rawOf(page), ["March BGL"]);
  const line = layoutCensusLine(march);
  assert.match(line, /^`March BGL`: group 0, 1, 10 entries; /u);
  assert.match(line, /vertex uniformBuffers 1\/12;/u);
  assert.match(
    line,
    /fragment sampledTextures 3\/16, uniformBuffers 2\/12, samplers 1\/16, externalTextures 1;/u,
  );
  assert.match(
    line,
    /compute sampledTextures 1\/16, storageBuffers 2\/8, storageTextures 1\/4$/u,
  );
});

test("readBindGroupLayoutCensus reads through a page's evaluate and reports an uninstalled census", async () => {
  const installed = makePage({
    limits: { maxSampledTexturesPerShaderStage: 16 },
  });
  drivePage(installed);
  const read = await readBindGroupLayoutCensus(installed, ["March BGL"]);
  assert.equal(read.installed, true);
  assert.equal(read.deviceFound, true);
  assert.equal(read.unlabelled, 1);
  assert.equal(read.rows[0].seen, true);

  const bare = makePage({ source: "" });
  const none = await readBindGroupLayoutCensus(bare, ["March BGL"]);
  assert.equal(none.installed, false);
  assert.equal(none.rows[0].seen, false);
});

test("a page without GPUDevice gets an empty census, and installing twice counts once", async () => {
  const context = vm.createContext({});
  vm.runInContext(BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE, context);
  assert.equal(
    vm.runInContext("__bindGroupLayoutCensus.installed", context),
    false,
  );

  const page = makePage();
  vm.runInContext(BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE, page.context);
  page.run(`__device.createBindGroupLayout({ label: "Once", entries: [] });`);
  const [row] = layoutCensusRows(await rawOf(page), ["Once"]);
  assert.equal(row.created, 1);
});

async function mutatedRaw(anchor, replacement) {
  const mutated = await importMutated(CENSUS_MODULE, [[anchor, replacement]]);
  const page = makePage({
    source: mutated.BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE,
  });
  drivePage(page);
  return page.evaluate(mutated.pageReadBindGroupLayoutCensus, { keys: [] });
}

test("inertness mutant: the stage-bit decoding made unreachable loses every per-stage count", async () => {
  const raw = await mutatedRaw(
    "if ((entry.visibility & bit) !== 0) {",
    "if (false && (entry.visibility & bit) !== 0) {",
  );
  assert.notDeepEqual(raw.layouts["March BGL"].counts, MARCH_COUNTS);
  assert.equal(raw.layouts["March BGL"].counts.fragment.sampledTextures, 0);
});

test("inertness mutant: the group-index recording made unreachable loses every group", async () => {
  const raw = await mutatedRaw(
    "if (label !== undefined) {",
    "if (false && label !== undefined) {",
  );
  assert.notDeepEqual(raw.groups["March BGL"], { 0: 1, 1: 1 });
  assert.deepEqual(raw.groups, {});
});

test("the module carries the kit header", () => {
  const source = fs.readFileSync(CENSUS_MODULE, "utf8");
  assert.match(source, /@purpose [^\n]+\n \* @status ACTIVE/u);
});
