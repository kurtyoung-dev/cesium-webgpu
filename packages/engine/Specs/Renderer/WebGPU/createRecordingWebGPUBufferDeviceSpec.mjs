import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRecordingWebGPUBufferDevice } from "./createRecordingWebGPUBufferDevice.js";

let mutantSequence = 0;

function replaceExactlyOnce(source, before, after) {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `missing mutation anchor: ${before}`);
  assert.equal(
    source.indexOf(before, first + before.length),
    -1,
    `duplicate mutation anchor: ${before}`,
  );
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

async function importMutant(name, before, after) {
  const helperSource = await readFile(
    new URL("./createRecordingWebGPUBufferDevice.js", import.meta.url),
    "utf8",
  );
  const source = replaceExactlyOnce(helperSource, before, after);
  const encoded = Buffer.from(source).toString("base64");
  mutantSequence++;
  return import(
    `data:text/javascript;base64,${encoded}#${name}-${mutantSequence}`
  );
}

function assertFreshBufferObjects(createFixture) {
  const { device, created } = createFixture();
  const descriptor = { size: 4, usage: 8, label: "buffer" };
  const first = device.createBuffer(descriptor);
  const second = device.createBuffer(descriptor);

  assert.deepEqual(created, [first, second]);
  assert.notStrictEqual(first, second);
}

function assertDestruction(createFixture) {
  const { device } = createFixture();
  const first = device.createBuffer({ size: 4, usage: 8, label: "first" });
  const second = device.createBuffer({ size: 4, usage: 8, label: "second" });

  assert.equal(first.destroyed, false);
  assert.equal(second.destroyed, false);

  first.destroy();

  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, false);
}

function assertWriteBufferArguments(createFixture) {
  const { device, writes } = createFixture();
  const buffer = {};
  const offset = {};
  const source = {};
  const srcOffset = {};
  const byteLength = {};

  device.queue.writeBuffer(buffer, offset, source, srcOffset, byteLength);

  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]), [
    "buffer",
    "offset",
    "source",
    "srcOffset",
    "byteLength",
  ]);
  assert.strictEqual(writes[0].buffer, buffer);
  assert.strictEqual(writes[0].offset, offset);
  assert.strictEqual(writes[0].source, source);
  assert.strictEqual(writes[0].srcOffset, srcOffset);
  assert.strictEqual(writes[0].byteLength, byteLength);
}

test("records descriptors in order and preserves their selected fields", () => {
  const { device, created, descriptors } = createRecordingWebGPUBufferDevice();
  const reads = [];
  const firstSize = {};
  const firstUsage = {};
  const firstLabel = {};
  const firstDescriptor = {
    get size() {
      reads.push("first:size");
      return firstSize;
    },
    get usage() {
      reads.push("first:usage");
      return firstUsage;
    },
    get label() {
      reads.push("first:label");
      return firstLabel;
    },
  };
  const secondSize = {};
  const secondUsage = {};
  const secondLabel = {};
  const secondDescriptor = {
    get size() {
      reads.push("second:size");
      return secondSize;
    },
    get usage() {
      reads.push("second:usage");
      return secondUsage;
    },
    get label() {
      reads.push("second:label");
      return secondLabel;
    },
  };

  const first = device.createBuffer(firstDescriptor);
  const second = device.createBuffer(secondDescriptor);

  assert.deepEqual(reads, [
    "first:size",
    "first:usage",
    "first:label",
    "second:size",
    "second:usage",
    "second:label",
  ]);
  assert.deepEqual(created, [first, second]);
  assert.equal(descriptors.length, 2);
  assert.strictEqual(descriptors[0], firstDescriptor);
  assert.strictEqual(descriptors[1], secondDescriptor);
  assert.notStrictEqual(first, second);
  assert.strictEqual(first.size, firstSize);
  assert.strictEqual(first.usage, firstUsage);
  assert.strictEqual(first.label, firstLabel);
  assert.strictEqual(second.size, secondSize);
  assert.strictEqual(second.usage, secondUsage);
  assert.strictEqual(second.label, secondLabel);
});

test("creates fresh buffers", () => {
  assertFreshBufferObjects(createRecordingWebGPUBufferDevice);
});

test("tracks destruction independently for each buffer", () => {
  assertDestruction(createRecordingWebGPUBufferDevice);
});

test("records all five writeBuffer arguments by identity and order", () => {
  assertWriteBufferArguments(createRecordingWebGPUBufferDevice);
});

test("keeps record arrays isolated between fixture instances", () => {
  const first = createRecordingWebGPUBufferDevice();
  const second = createRecordingWebGPUBufferDevice();

  first.device.createBuffer({ size: 4, usage: 8, label: "first" });
  first.device.queue.writeBuffer({}, 0, {}, 0, 4);

  assert.equal(first.created.length, 1);
  assert.equal(first.descriptors.length, 1);
  assert.equal(first.writes.length, 1);
  assert.notStrictEqual(second.created, first.created);
  assert.notStrictEqual(second.descriptors, first.descriptors);
  assert.notStrictEqual(second.writes, first.writes);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.descriptors, []);
  assert.deepEqual(second.writes, []);
});

test("leaves unsupported GPU operations absent", () => {
  const { device } = createRecordingWebGPUBufferDevice();

  assert.deepEqual(Object.keys(device), ["createBuffer", "queue"]);
  assert.deepEqual(Object.keys(device.queue), ["writeBuffer"]);
  assert.equal(device.createTexture, undefined);
  assert.equal(device.queue.submit, undefined);
  assert.throws(() => device.createTexture({}), TypeError);
  assert.throws(() => device.queue.submit([]), TypeError);
});

test("write contract rejects a dropped source offset", async () => {
  const mutant = await importMutant(
    "drop-source-offset",
    "writes.push({ buffer, offset, source, srcOffset, byteLength });",
    "writes.push({ buffer, offset, source, byteLength });",
  );

  assert.throws(
    () => assertWriteBufferArguments(mutant.createRecordingWebGPUBufferDevice),
    assert.AssertionError,
  );
});

test("write contract rejects a dropped byte length", async () => {
  const mutant = await importMutant(
    "drop-byte-length",
    "writes.push({ buffer, offset, source, srcOffset, byteLength });",
    "writes.push({ buffer, offset, source, srcOffset });",
  );

  assert.throws(
    () => assertWriteBufferArguments(mutant.createRecordingWebGPUBufferDevice),
    assert.AssertionError,
  );
});

test("destruction contract rejects a missing state transition", async () => {
  const mutant = await importMutant(
    "omit-destruction",
    "this.destroyed = true;",
    "this.destroyed = false;",
  );

  assert.throws(
    () => assertDestruction(mutant.createRecordingWebGPUBufferDevice),
    assert.AssertionError,
  );
});

test("creation contract rejects buffer object reuse", async () => {
  const mutant = await importMutant(
    "reuse-buffer",
    "return buffer;",
    "return created[0];",
  );

  assert.throws(
    () => assertFreshBufferObjects(mutant.createRecordingWebGPUBufferDevice),
    assert.AssertionError,
  );
});
