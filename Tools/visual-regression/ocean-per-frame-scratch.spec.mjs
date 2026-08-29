import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createContext, runInContext, Script } from "node:vm";
import { transformSync } from "esbuild";

const rendererPath = resolve(
  process.cwd(),
  "packages/engine/Source/Renderer/WebGPU/WebGPUOceanRenderer.ts",
);
const rendererSource = readFileSync(rendererPath, "utf8").replace(
  /\r\n/g,
  "\n",
);

const WRITER_START =
  "  const elapsedSeconds = resolveOceanSimulationSeconds(p, frameState);";
const WRITER_END = "  // ── Compute chain ──";
const INVOCATION_COUNT = 5;

function uniqueOffset(text, anchor) {
  const first = text.indexOf(anchor);
  assert.notEqual(first, -1, `missing lift anchor: ${anchor}`);
  assert.equal(
    text.indexOf(anchor, first + anchor.length),
    -1,
    `lift anchor is not unique: ${anchor}`,
  );
  return first;
}

function liftWriterBody() {
  const start = uniqueOffset(rendererSource, WRITER_START);
  const end = uniqueOffset(rendererSource, WRITER_END);
  assert.ok(end > start, "writer anchors are out of order");
  return rendererSource.slice(start, end).trimEnd();
}

function compileWriter(body) {
  const liftedTypeScript = `
const FALLBACK_FRAME_SECONDS = 1.0 / 60.0;

function resolveOceanSimulationSeconds(
  _p: unknown,
  frameState: { elapsedSeconds?: number },
): number | undefined {
  return frameState.elapsedSeconds;
}

export function createCache(): any {
  return {
    simulationSeconds: 0,
    timeParamsBuffer: { label: "time-target" },
    mergeParamsBuffer: { label: "merge-target" },
    timeParamsScratch: new ArrayBuffer(32),
    mergeParamsScratch: new ArrayBuffer(32),
  };
}

export function writePerFrame(
  p: any,
  frameState: any,
  cache: any,
  device: any,
  N: number,
  patchLength: number,
  gravity: number,
): void {
${body}
}

export function arrayBufferConstructionCount(): number {
  return (globalThis as any).__arrayBufferConstructionCount;
}
`;

  const { code } = transformSync(liftedTypeScript, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  });

  const moduleRecord = { exports: {} };
  const context = createContext({
    module: moduleRecord,
    exports: moduleRecord.exports,
  });

  runInContext(
    `
const NativeArrayBuffer = globalThis.ArrayBuffer;
globalThis.__arrayBufferConstructionCount = 0;
globalThis.ArrayBuffer = class CountingArrayBuffer extends NativeArrayBuffer {
  constructor(byteLength) {
    super(byteLength);
    globalThis.__arrayBufferConstructionCount += 1;
  }
};
`,
    context,
  );

  new Script(code, {
    filename: "lifted-ocean-per-frame-writer.cjs",
  }).runInContext(context);

  return moduleRecord.exports;
}

function runHarness(body) {
  const api = compileWriter(body);
  const cache = api.createCache();
  const allocationsAtCacheCreation = api.arrayBufferConstructionCount();
  const writes = [];

  const device = {
    queue: {
      writeBuffer(target, offset, data) {
        writes.push({
          target,
          offset,
          data,
          bytes: Array.from(new Uint8Array(data)),
        });
      },
    },
  };

  const p = {
    _timeSpeed: 2.0,
    _choppiness: 1.5,
    _heightScale: 0.5,
    _foamThreshold: 0.25,
    _foamScale: 2.0,
  };
  const timeInputs = [1.5, 3.25, 4.0, 5.0, 6.0];
  assert.equal(timeInputs.length, INVOCATION_COUNT);

  const allocationsAfterCalls = [];
  for (const elapsedSeconds of timeInputs) {
    api.writePerFrame(p, { elapsedSeconds }, cache, device, 256, 250.0, 9.81);
    allocationsAfterCalls.push(api.arrayBufferConstructionCount());
  }

  return {
    cache,
    writes,
    allocationsAtCacheCreation,
    allocationsAfterCalls,
    timeWrites: writes.filter(
      ({ target }) => target === cache.timeParamsBuffer,
    ),
    mergeWrites: writes.filter(
      ({ target }) => target === cache.mergeParamsBuffer,
    ),
  };
}

function assertStableScratchRun(result) {
  const afterFirst = result.allocationsAfterCalls[0];

  assert.deepEqual(
    result.allocationsAfterCalls.slice(1),
    Array(INVOCATION_COUNT - 1).fill(afterFirst),
    "a call after the first allocated a new ArrayBuffer",
  );
  assert.equal(
    afterFirst,
    result.allocationsAtCacheCreation,
    "the first writer call allocated a new ArrayBuffer",
  );

  assert.equal(result.timeWrites.length, INVOCATION_COUNT);
  assert.equal(result.mergeWrites.length, INVOCATION_COUNT);

  for (const write of result.writes) {
    assert.equal(write.offset, 0);
    assert.equal(write.data.byteLength, 32);
  }

  for (const write of result.timeWrites) {
    assert.strictEqual(write.data, result.cache.timeParamsScratch);
  }
  for (const write of result.mergeWrites) {
    assert.strictEqual(write.data, result.cache.mergeParamsScratch);
  }
}

function makeOriginalAllocationMutant(body) {
  const replacements = [
    [
      "  const timeBuf = cache.timeParamsScratch!;",
      "  const timeBuf = new ArrayBuffer(32);",
    ],
    [
      "  const mergeBuf = cache.mergeParamsScratch!;",
      "  const mergeBuf = new ArrayBuffer(32);",
    ],
  ];

  let mutant = body;
  for (const [current, original] of replacements) {
    assert.equal(
      mutant.split(current).length - 1,
      1,
      `expected exactly one mutant target: ${current}`,
    );
    mutant = mutant.replace(current, original);
  }
  return mutant;
}

// Literal little-endian IEEE-754 bytes, not generated by the tested views.
const EXPECTED_TIME_AT_1_5 = [
  0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 122, 67, 195, 245, 28, 65, 0, 0, 64, 64, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

const EXPECTED_TIME_AT_3_25 = [
  0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 122, 67, 195, 245, 28, 65, 0, 0, 208, 64, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

const EXPECTED_MERGE = [
  0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 122, 67, 0, 0, 192, 63, 0, 0, 0, 63, 0, 0, 128,
  62, 0, 0, 0, 64, 0, 0, 0, 0,
];

test("per-frame ocean writers reuse cache scratch and kill allocation mutants", () => {
  const writerBody = liftWriterBody();
  const actual = runHarness(writerBody);

  assert.equal(actual.allocationsAtCacheCreation, 2);
  assertStableScratchRun(actual);
  assert.deepEqual(actual.timeWrites[0].bytes, EXPECTED_TIME_AT_1_5);
  assert.deepEqual(actual.timeWrites[1].bytes, EXPECTED_TIME_AT_3_25);
  assert.deepEqual(actual.mergeWrites[0].bytes, EXPECTED_MERGE);
  assert.deepEqual(actual.mergeWrites[1].bytes, EXPECTED_MERGE);

  const mutant = runHarness(makeOriginalAllocationMutant(writerBody));
  assert.ok(
    mutant.allocationsAfterCalls.at(-1) > mutant.allocationsAfterCalls[0],
    "original per-frame allocation mutant did not increase the count",
  );
  assert.notStrictEqual(mutant.timeWrites[0].data, mutant.timeWrites[1].data);
  assert.notStrictEqual(mutant.mergeWrites[0].data, mutant.mergeWrites[1].data);
  assert.throws(
    () => assertStableScratchRun(mutant),
    /after the first allocated a new ArrayBuffer/,
  );
});
