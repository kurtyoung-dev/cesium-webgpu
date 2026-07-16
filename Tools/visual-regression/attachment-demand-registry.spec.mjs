// C9-09-ATTACHMENT-DEMAND-REGISTRY — pure-function Node spec.
//
// `computeAttachmentDemand` lives in a TypeScript module that is only bundled
// into the combined engine barrel (no per-file JS build output) and is not
// re-exported from the public barrel. To unit-test the pure function without a
// browser we transpile just that one source file with esbuild and import the
// resulting module. This exercises the full 2^6 reader-combination matrix plus
// the conservative-force and observe-only-family contracts.
//
// Run: node --test Tools/visual-regression/attachment-demand-registry.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const registryTsPath = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUAttachmentDemandRegistry.ts",
);

const tsSource = await readFile(registryTsPath, "utf8");
const { code } = await transform(tsSource, {
  loader: "ts",
  format: "esm",
  target: "es2022",
});
// Import the transpiled module from a data: URL so no temp file is left behind.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const { computeAttachmentDemand, GBUFFER_READER_BITS } = await import(moduleUrl);

// `pathToFileURL` retained only to prove the anchor resolves on all platforms.
void pathToFileURL;

const READER_FLAGS = [
  "_enableSSR",
  "_enableNPROutlines",
  "_enableContactShadows",
  "deferredLighting",
  "debugShowGBufferNormals",
];

function sceneWith(overrides = {}) {
  return {
    _enableSSR: false,
    _enableNPROutlines: false,
    _enableContactShadows: false,
    deferredLighting: false,
    debugShowGBufferNormals: false,
    taaEnabled: false,
    _useOIT: false,
    _enableEdgeVisibility: false,
    postProcessStages: { ambientOcclusion: { enabled: false } },
    ...overrides,
  };
}

test("default scene: no readers, forced MRT keeps mrt topology", () => {
  const rec = computeAttachmentDemand(sceneWith(), { forceSceneMRT: true });
  assert.equal(rec.gbufferReadersDemand, false);
  assert.equal(rec.gbufferReadersMask, 0);
  assert.equal(rec.forceSceneMRT, true);
  assert.equal(rec.gbufferDemanded, true);
  assert.equal(rec.topology, "mrt");
  for (const k of Object.keys(rec.gbufferReaders)) {
    assert.equal(rec.gbufferReaders[k], false, `${k} should be false`);
  }
});

test("no readers + forceSceneMRT=false => one-target topology, zero demand", () => {
  const rec = computeAttachmentDemand(sceneWith(), { forceSceneMRT: false });
  assert.equal(rec.gbufferReadersDemand, false);
  assert.equal(rec.gbufferDemanded, false);
  assert.equal(rec.topology, "one-target");
});

test("each single reader independently demands MRT (force off)", () => {
  const cases = [
    ["_enableSSR", "ssr", GBUFFER_READER_BITS.SSR],
    ["_enableNPROutlines", "nprOutlines", GBUFFER_READER_BITS.NPR_OUTLINES],
    [
      "_enableContactShadows",
      "contactShadows",
      GBUFFER_READER_BITS.CONTACT_SHADOWS,
    ],
    ["deferredLighting", "deferredLighting", GBUFFER_READER_BITS.DEFERRED_LIGHTING],
    ["debugShowGBufferNormals", "debugOverlay", GBUFFER_READER_BITS.DEBUG_OVERLAY],
  ];
  for (const [flag, readerKey, bit] of cases) {
    const rec = computeAttachmentDemand(sceneWith({ [flag]: true }), {
      forceSceneMRT: false,
    });
    assert.equal(rec.gbufferReaders[readerKey], true, `${readerKey} true`);
    assert.equal(rec.gbufferReadersDemand, true);
    assert.equal(rec.gbufferDemanded, true);
    assert.equal(rec.topology, "mrt");
    assert.equal((rec.gbufferReadersMask & bit) !== 0, true, `${readerKey} bit`);
  }
});

test("ssgi requires AO enabled AND deferred lighting", () => {
  // AO on but deferred off => no ssgi demand
  const aoOnly = computeAttachmentDemand(
    sceneWith({ postProcessStages: { ambientOcclusion: { enabled: true } } }),
    { forceSceneMRT: false },
  );
  assert.equal(aoOnly.gbufferReaders.ssgi, false);
  assert.equal(aoOnly.gbufferReadersDemand, false);
  assert.equal(aoOnly.topology, "one-target");

  // AO on AND deferred on => ssgi demand (subsumed by deferredLighting too)
  const ssgi = computeAttachmentDemand(
    sceneWith({
      deferredLighting: true,
      postProcessStages: { ambientOcclusion: { enabled: true } },
    }),
    { forceSceneMRT: false },
  );
  assert.equal(ssgi.gbufferReaders.ssgi, true);
  assert.equal(ssgi.gbufferReaders.deferredLighting, true);
  assert.equal((ssgi.gbufferReadersMask & GBUFFER_READER_BITS.SSGI) !== 0, true);
  assert.equal(ssgi.topology, "mrt");
});

test("full 2^5 primary-reader combination matrix maps to correct topology", () => {
  for (let mask = 0; mask < 1 << READER_FLAGS.length; mask++) {
    const overrides = {};
    for (let i = 0; i < READER_FLAGS.length; i++) {
      if (mask & (1 << i)) overrides[READER_FLAGS[i]] = true;
    }
    const rec = computeAttachmentDemand(sceneWith(overrides), {
      forceSceneMRT: false,
    });
    const anyReader = mask !== 0;
    assert.equal(rec.gbufferReadersDemand, anyReader, `mask ${mask} demand`);
    assert.equal(
      rec.topology,
      anyReader ? "mrt" : "one-target",
      `mask ${mask} topology`,
    );
    // forceSceneMRT=true must ALWAYS yield mrt regardless of readers.
    const forced = computeAttachmentDemand(sceneWith(overrides), {
      forceSceneMRT: true,
    });
    assert.equal(forced.topology, "mrt", `mask ${mask} forced topology`);
    assert.equal(forced.gbufferDemanded, true, `mask ${mask} forced demand`);
  }
});

test("observe-only families are recorded, not folded into gbuffer demand", () => {
  const rec = computeAttachmentDemand(
    sceneWith({
      taaEnabled: true,
      _useOIT: true,
      _enableEdgeVisibility: true,
    }),
    { forceSceneMRT: false, picking: false, globeDepth: true, postProcess: true },
  );
  // None of these are G-buffer readers.
  assert.equal(rec.gbufferReadersDemand, false);
  assert.equal(rec.topology, "one-target");
  // But they ARE observed.
  assert.equal(rec.other.velocityTarget, true);
  assert.equal(rec.other.oitRequested, true);
  assert.equal(rec.other.edgeMrt, true);
  assert.equal(rec.other.globeDepth, true);
  assert.equal(rec.other.postProcess, true);
  assert.equal(rec.other.picking, false);
});

test("purity: same inputs produce deeply-equal records", () => {
  const s = sceneWith({ _enableSSR: true, deferredLighting: true });
  const a = computeAttachmentDemand(s, { forceSceneMRT: false });
  const b = computeAttachmentDemand(s, { forceSceneMRT: false });
  assert.deepEqual(a, b);
});
