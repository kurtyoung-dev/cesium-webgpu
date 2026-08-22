// Empty-module stub hardening contract.
// @purpose Prove the single-backend build stub answers instanceof without throwing, keeps throwing on real use, and binds every named export of a stubbed module.
// @status ACTIVE
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bundleVariantPlugin,
  collectRuntimeExportNames,
  createEmptyModuleStubSource,
} from "../../scripts/bundleVariantPlugin.js";
import stub from "../../scripts/stubs/emptyModule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const stubModulePath = path.join(
  repoRoot,
  "scripts",
  "stubs",
  "emptyModule.js",
);

function moduleDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

function setupPluginHarness() {
  let onResolveHandler;
  let onLoadHandler;
  const plugin = bundleVariantPlugin("webgl-only");
  plugin.setup({
    onLoad(_options, handler) {
      onLoadHandler = handler;
    },
    onResolve(_options, handler) {
      onResolveHandler = handler;
    },
  });
  return { onLoadHandler, onResolveHandler };
}

test("instanceof against the stub returns false without throwing", () => {
  assert.doesNotThrow(() => Object.create(null) instanceof stub);
  assert.equal(Object.create(null) instanceof stub, false);
});

test("benign module-load introspection remains non-throwing", () => {
  assert.equal(stub.__esModule, undefined);
  assert.equal(stub.then, undefined);
  assert.equal(stub[Symbol.toStringTag], undefined);
  assert.equal(stub[Symbol.hasInstance]({}), false);
});

test("accessing a non-whitelisted property still throws", () => {
  assert.throws(() => stub.runtimeApi, /WebGPU code was reached/u);
  assert.throws(() => stub(), /WebGPU code was reached/u);
  assert.throws(() => Reflect.construct(stub, []), /WebGPU code was reached/u);
});

test("meaningful coercion and reflection probes stay on the throwing path", () => {
  const rejectedProperties = [
    Symbol.toPrimitive,
    Symbol.iterator,
    Symbol.asyncIterator,
    "prototype",
    "constructor",
    "default",
  ];
  for (const property of rejectedProperties) {
    assert.throws(
      () => Reflect.get(stub, property),
      /WebGPU code was reached/u,
    );
  }
});

test("the named-export redirect binds every runtime name to the stub", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "cesium-empty-module-"),
  );
  try {
    const sourcePath = path.join(
      temporaryRoot,
      "packages",
      "engine",
      "Source",
      "Renderer",
      "WebGPU",
      "Fixture.ts",
    );
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      [
        "export default class Fixture {}",
        "export class Foo {}",
        "export const Bar = 1;",
        "export type TypeOnly = string;",
        "export { Bar as Alias, type TypeOnly as TypeAlias };",
        "",
      ].join("\n"),
      "utf8",
    );

    const { onLoadHandler, onResolveHandler } = setupPluginHarness();
    assert.equal(typeof onResolveHandler, "function");
    assert.equal(typeof onLoadHandler, "function");

    const scenePath = path.join(
      temporaryRoot,
      "packages",
      "engine",
      "Source",
      "Scene",
      "Scene.js",
    );
    const resolution = onResolveHandler({
      path: "../Renderer/WebGPU/Fixture.js",
      importer: scenePath,
      resolveDir: path.dirname(scenePath),
      namespace: "file",
      kind: "import-statement",
      pluginData: undefined,
    });
    assert.equal(resolution.path, stubModulePath);
    assert.equal(resolution.namespace, "cesium-empty-module");
    assert.match(resolution.suffix, /^\?source=/u);
    assert.equal(resolution.pluginData.sourcePath, sourcePath);

    const loaded = await onLoadHandler({
      path: resolution.path,
      namespace: resolution.namespace,
      suffix: resolution.suffix,
      pluginData: resolution.pluginData,
    });
    assert.deepEqual(loaded.watchFiles, [sourcePath]);
    assert.match(loaded.contents, /stub as Foo/u);
    assert.doesNotMatch(loaded.contents, /TypeOnly|TypeAlias/u);

    const executableContents = loaded.contents.replace(
      JSON.stringify("./stubs/emptyModule.js"),
      JSON.stringify(pathToFileURL(stubModulePath).href),
    );
    assert.notEqual(executableContents, loaded.contents);
    const shimUrl = moduleDataUrl(executableContents);
    const consumerUrl = moduleDataUrl(
      `import defaultStub, { Foo } from ${JSON.stringify(shimUrl)};\n` +
        "export { Foo };\n" +
        "export const sameBinding = Foo === defaultStub;\n",
    );
    const consumer = await import(consumerUrl);

    assert.equal(consumer.sameBinding, true);
    assert.strictEqual(consumer.Foo, stub);
    assert.throws(() => consumer.Foo.runtimeApi, /WebGPU code was reached/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("stub source generation rejects names that cannot link statically", () => {
  assert.throws(
    () => createEmptyModuleStubSource(["not-an-identifier"]),
    /Unsupported empty-module export name/u,
  );
});

test("runtime export collection fails loudly on export-star modules", async () => {
  await assert.rejects(
    () => collectRuntimeExportNames('export * from "./other.js";', "star.ts"),
    /Cannot create a named empty-module stub/u,
  );
});
