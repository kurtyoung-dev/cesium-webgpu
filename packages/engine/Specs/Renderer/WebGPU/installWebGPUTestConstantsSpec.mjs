import assert from "node:assert/strict";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

const helperUrl = new URL("./installWebGPUTestConstants.js", import.meta.url);
const constantNames = [
  "GPUBufferUsage",
  "GPUShaderStage",
  "GPUTextureUsage",
  "GPUMapMode",
];

const expectedConstants = {
  GPUBufferUsage: {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  },
  GPUShaderStage: {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
  },
  GPUTextureUsage: {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
    TRANSIENT_ATTACHMENT: 0x20,
  },
  GPUMapMode: {
    READ: 0x0001,
    WRITE: 0x0002,
  },
};

function snapshotHostDescriptors() {
  return Object.fromEntries(
    constantNames.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
}

function restoreHostDescriptors(descriptors) {
  for (const name of constantNames) {
    const descriptor = descriptors[name];
    if (descriptor === undefined) {
      delete globalThis[name];
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }
  }
}

function assertCanonicalConstants(actual) {
  assert.deepEqual(Object.keys(actual), constantNames);
  for (const name of constantNames) {
    assert.deepEqual(actual[name], expectedConstants[name]);
    assert.deepEqual(
      Object.keys(actual[name]),
      Object.keys(expectedConstants[name]),
    );
  }
}

function mutateOnce(source, before, afterText) {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `mutation anchor not found: ${before}`);
  assert.equal(
    source.indexOf(before, first + before.length),
    -1,
    `mutation anchor is not unique: ${before}`,
  );
  return `${source.slice(0, first)}${afterText}${source.slice(
    first + before.length,
  )}`;
}

function toDataModule(source) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

function runModuleGraph(moduleUrls) {
  const entry = moduleUrls
    .map((moduleUrl) => `import ${JSON.stringify(moduleUrl)};`)
    .join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", entry], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
}

function assertGraphPassed(result) {
  assert.equal(
    result.status,
    0,
    `module graph failed:\n${result.error ?? ""}\n${result.stderr}`,
  );
}

function assertGraphFailed(result) {
  assert.notEqual(
    result.status,
    0,
    "the deliberately broken module graph unexpectedly passed",
  );
}

const originalHostDescriptors = snapshotHostDescriptors();
const originalHostValues = Object.fromEntries(
  constantNames.map((name) => [name, globalThis[name]]),
);
const { default: installWebGPUTestConstants, webGPUTestConstants } =
  await import(helperUrl.href);
const helperSource = (await readFile(helperUrl, "utf8")).replaceAll(
  "\r\n",
  "\n",
);

after(() => {
  restoreHostDescriptors(originalHostDescriptors);
});

test("exports the complete canonical WebGPU constant maps", () => {
  assertCanonicalConstants(webGPUTestConstants);
  assert.ok(Object.isFrozen(webGPUTestConstants));
  for (const name of constantNames) {
    assert.ok(Object.isFrozen(webGPUTestConstants[name]), `${name} is mutable`);
  }
});

test("module evaluation installs missing host maps without replacing existing ones", () => {
  for (const name of constantNames) {
    if (originalHostValues[name] === undefined) {
      assert.strictEqual(globalThis[name], webGPUTestConstants[name]);
    } else {
      assert.strictEqual(globalThis[name], originalHostValues[name]);
    }
  }
});

test("installs every map into an isolated target without touching the host", () => {
  const before = snapshotHostDescriptors();
  const target = Object.create(null);

  installWebGPUTestConstants(target);

  assertCanonicalConstants(target);
  assert.deepEqual(snapshotHostDescriptors(), before);
});

test("preserves sentinels independently and is idempotent", () => {
  const before = snapshotHostDescriptors();
  const bufferSentinel = Object.freeze({ sentinel: "buffer" });
  const textureSentinel = Object.freeze({ sentinel: "texture" });
  const target = {
    GPUBufferUsage: bufferSentinel,
    GPUTextureUsage: textureSentinel,
  };

  installWebGPUTestConstants(target);
  const installedShaderStage = target.GPUShaderStage;
  const installedMapMode = target.GPUMapMode;
  installWebGPUTestConstants(target);

  assert.strictEqual(target.GPUBufferUsage, bufferSentinel);
  assert.strictEqual(target.GPUTextureUsage, textureSentinel);
  assert.strictEqual(target.GPUShaderStage, installedShaderStage);
  assert.strictEqual(target.GPUMapMode, installedMapMode);
  assert.strictEqual(installedShaderStage, webGPUTestConstants.GPUShaderStage);
  assert.strictEqual(installedMapMode, webGPUTestConstants.GPUMapMode);
  assert.deepEqual(snapshotHostDescriptors(), before);
});

const canonicalProbeSource = `
const expected = ${JSON.stringify(expectedConstants)};
for (const [name, expectedMap] of Object.entries(expected)) {
  const actualMap = globalThis[name];
  if (actualMap === undefined) {
    throw new Error(name + " was unavailable at subject evaluation");
  }
  const actualKeys = Object.keys(actualMap);
  const expectedKeys = Object.keys(expectedMap);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(name + " has an incomplete member set");
  }
  for (const [member, value] of Object.entries(expectedMap)) {
    if (actualMap[member] !== value) {
      throw new Error(name + "." + member + " has the wrong bit");
    }
  }
}
`;

test("the wrong-bit mutant is rejected", () => {
  const mutant = mutateOnce(
    helperSource,
    "  QUERY_RESOLVE: 0x0200,",
    "  QUERY_RESOLVE: 0x0100,",
  );
  assertGraphFailed(
    runModuleGraph([toDataModule(mutant), toDataModule(canonicalProbeSource)]),
  );
});

test("the omitted-member mutant is rejected", () => {
  const mutant = mutateOnce(
    helperSource,
    "  TRANSIENT_ATTACHMENT: 0x20,\n",
    "",
  );
  assertGraphFailed(
    runModuleGraph([toDataModule(mutant), toDataModule(canonicalProbeSource)]),
  );
});

test("the unconditional-overwrite mutant is rejected", () => {
  const mutant = mutateOnce(
    helperSource,
    'if (typeof target[name] === "undefined") {',
    "if (true) {",
  );
  const setupSource = `
const sentinel = Object.freeze({ sentinel: true });
globalThis.__webGPUTestSentinel = sentinel;
for (const name of ${JSON.stringify(constantNames)}) {
  globalThis[name] = sentinel;
}
`;
  const sentinelProbeSource = `
for (const name of ${JSON.stringify(constantNames)}) {
  if (globalThis[name] !== globalThis.__webGPUTestSentinel) {
    throw new Error(name + " was overwritten");
  }
}
`;

  assertGraphFailed(
    runModuleGraph([
      toDataModule(setupSource),
      toDataModule(mutant),
      toDataModule(sentinelProbeSource),
    ]),
  );
});

test("a controlled subject fails when evaluated before the installer", () => {
  const helperModule = toDataModule(helperSource);
  const subjectModule = toDataModule(canonicalProbeSource);

  assertGraphPassed(runModuleGraph([helperModule, subjectModule]));
  assertGraphFailed(runModuleGraph([subjectModule, helperModule]));
});
