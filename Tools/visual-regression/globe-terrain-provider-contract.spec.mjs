// globe-terrain-provider-contract.spec.mjs — three defect contracts for the
// imagery/terrain provider chain, each driven through the real engine module
// rather than a twin, and each asserting an OUTPUT the defect changes.
//
// @purpose Pins three provider-chain behaviours in Node: zero-padded tile URLs never throw, a rejected availability request is evicted and re-issued, and destroying an imagery layer releases its queued reprojection references.
// @status ACTIVE
//
// WHY THESE THREE ARE NODE-PROVABLE. None of them needs a GPU:
//
//   1. `UrlTemplateImageryProvider.requestImage` builds the tile Resource
//      synchronously and only then hands it to `ImageryProvider.loadImage`.
//      Replacing that one static with a recorder yields the real URL string
//      the real template code produced.
//   2. `CesiumTerrainProvider.loadTileDataAvailability` reaches the layered
//      availability cache through `checkLayer`, whose only outside dependency
//      is the layer's `Resource`. A recorder Resource counts the requests the
//      cache does or does not suppress.
//   3. `ImageryLayer._reprojectTexture` reaches its ComputeCommand branch when
//      the context exposes no feature renderer, and the command's `canceled`
//      hook is the real one, so a real `Imagery`'s reference count is the
//      observable that teardown either restores or leaks.
//
// TWO RESOLVER HOOKS ARE NEEDED for (3). `ImageryLayer` pulls GLSL shader
// string modules that `gulp build` generates into `packages/engine/Source/
// Shaders/**/*.js` (gitignored), and it pulls sibling engine `.ts` modules
// through `.js` specifiers. This spec may not build, so it stubs the absent
// shader leaves with the empty string — none of the three contracts reads a
// shader — and reuses the repo's `.ts` resolver for the rest. `node --test`
// gives each spec file its own process, so neither hook escapes this file.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const ENGINE = new URL("../../packages/engine/Source/", import.meta.url);

const isAbsentShaderModule = (url) =>
  /\/Source\/Shaders\/.*\.js$/.test(url) && !fs.existsSync(fileURLToPath(url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith(".js") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      typeof context.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      const target = new URL(specifier, context.parentURL);
      if (isAbsentShaderModule(target.href)) {
        return { url: target.href, format: "module", shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (isAbsentShaderModule(url)) {
      return {
        format: "module",
        source: 'export default "";',
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
enableEngineTsResolution();

const load = async (relative) =>
  (await import(new URL(relative, ENGINE).href)).default;

// Whether the eviction leaves an unhandled rejection behind is one of the
// outputs the availability test asserts, so for the span of that test this file
// owns the event: the runner's own listener would end the test at the first
// rejection and report that instead of the request count the test exists to
// measure. Both listeners are swapped back before the test returns.
async function withRecordedUnhandledRejections(body) {
  const runnerListeners = process.listeners("unhandledRejection");
  const recorded = [];
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => recorded.push(reason));
  try {
    return await body(recorded);
  } finally {
    process.removeAllListeners("unhandledRejection");
    for (const listener of runnerListeners) {
      process.on("unhandledRejection", listener);
    }
  }
}

// Node reports an unhandled rejection at the end of a turn of the event loop,
// so a settled-and-unhandled promise is only observable after one macrotask.
const drain = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a zero-padded tile coordinate wider than its template yields the coordinate, not a RangeError", async () => {
  const UrlTemplateImageryProvider = await load(
    "Scene/UrlTemplateImageryProvider.js",
  );
  const ImageryProvider = await load("Scene/ImageryProvider.js");

  const requested = [];
  const realLoadImage = ImageryProvider.loadImage;
  ImageryProvider.loadImage = (provider, resource) => {
    requested.push(resource.url);
    return Promise.resolve({});
  };

  try {
    const provider = new UrlTemplateImageryProvider({
      url: "https://example.invalid/{z}/{x}/{y}.png",
      urlSchemeZeroPadding: { "{x}": "00" },
    });

    // Narrower than the template: padded to the template's width.
    await provider.requestImage(7, 0, 4);
    assert.equal(requested.at(-1), "https://example.invalid/4/07/0.png");

    // Two digits wider than the template: emitted unpadded and unmangled.
    // `new Array(2 - 4 + 1)` is the RangeError this pins.
    await provider.requestImage(1000, 0, 10);
    assert.equal(requested.at(-1), "https://example.invalid/10/1000/0.png");

    // Exactly one digit wider — the widest input that never threw — is
    // unchanged, which is what makes the fix a pure removal of the throw.
    await provider.requestImage(123, 0, 7);
    assert.equal(requested.at(-1), "https://example.invalid/7/123/0.png");
  } finally {
    ImageryProvider.loadImage = realLoadImage;
  }
});

test("a rejected availability request is evicted from the layer cache and the next call re-requests", async () => {
  const CesiumTerrainProvider = await load("Core/CesiumTerrainProvider.js");
  const WebMercatorTilingScheme = await load("Core/WebMercatorTilingScheme.js");

  let fetchCount = 0;
  const layer = {
    availabilityLevels: 10,
    availability: { isTileAvailable: () => true },
    availabilityTilesLoaded: { isTileAvailable: () => false },
    availabilityPromiseCache: {},
    tileUrlTemplates: ["{z}/{x}/{y}.terrain"],
    version: "1.0.0",
    resource: {
      getDerivedResource: () => ({
        fetchArrayBuffer: () => {
          ++fetchCount;
          return Promise.reject(new Error("503 Service Unavailable"));
        },
      }),
    },
  };

  // The first layer carries no `availabilityLevels`, so `checkLayer` returns
  // immediately for it and the cached branch below is the layered one.
  const provider = Object.create(CesiumTerrainProvider.prototype);
  provider._availability = { isTileAvailable: () => false, _maximumLevel: 20 };
  provider._hasMetadata = true;
  provider._layers = [{}, layer];
  provider._scheme = "tms";
  provider._tilingScheme = new WebMercatorTilingScheme();
  provider._requestVertexNormals = false;
  provider._requestWaterMask = false;
  provider._requestMetadata = false;

  await withRecordedUnhandledRejections(async (unhandled) => {
    await provider.loadTileDataAvailability(5, 6, 12).catch(() => {});
    await drain();
    assert.equal(fetchCount, 1);
    assert.deepEqual(Object.keys(layer.availabilityPromiseCache), []);

    await provider.loadTileDataAvailability(5, 6, 12).catch(() => {});
    await drain();
    assert.equal(fetchCount, 2);

    // The eviction must not leave its own derived promise unhandled.
    assert.deepEqual(unhandled, []);
  });
});

test("destroying an imagery layer cancels its queued reprojections and returns the imagery reference count", async () => {
  const ImageryLayer = await load("Scene/ImageryLayer.js");
  const Imagery = await load("Scene/Imagery.js");
  const ImageryState = await load("Scene/ImageryState.js");
  const Rectangle = await load("Core/Rectangle.js");
  const WebMercatorTilingScheme = await load("Core/WebMercatorTilingScheme.js");

  const layer = Object.create(ImageryLayer.prototype);
  layer._imageryProvider = {
    tilingScheme: new WebMercatorTilingScheme(),
    ready: true,
  };
  layer._reprojectComputeCommands = [];
  layer._imageryCache = {};

  const imagery = new Imagery(
    layer,
    0,
    0,
    0,
    Rectangle.fromDegrees(0, 0, 1, 1),
  );
  imagery.textureWebMercator = { width: 1 };
  // The reference a TileImagery holds while the tile is alive.
  imagery.addReference();
  const referencesBeforeQueueing = imagery.referenceCount;

  // No feature renderer: the Mercator tile takes the ComputeCommand branch,
  // which is the one that takes a reference the command's hooks must release.
  const frameState = { context: { getFeatureRenderer: () => undefined } };
  layer._reprojectTexture(frameState, imagery, true);
  assert.equal(layer._reprojectComputeCommands.length, 1);
  assert.equal(imagery.referenceCount, referencesBeforeQueueing + 1);

  layer.destroy();

  assert.equal(layer._reprojectComputeCommands.length, 0);
  assert.equal(imagery.referenceCount, referencesBeforeQueueing);
  assert.equal(imagery.state, ImageryState.TEXTURE_LOADED);
});
