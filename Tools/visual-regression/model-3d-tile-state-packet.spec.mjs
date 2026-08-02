import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import Color from "../../packages/engine/Source/Core/Color.js";
import {
  applyModel3DTileStatePacket,
  refreshModel3DTileStatePacket,
} from "../../packages/engine/Source/Scene/Model/Model3DTileStatePacket.js";

function makeTileset() {
  return {
    colorBlendAmount: 0.5,
    colorBlendMode: 1,
    customShader: { name: "shader-a" },
    featureIdLabel: "featureId_0",
    instanceFeatureIdLabel: "instanceFeatureId_0",
    lightColor: new Cartesian3(1.0, 0.5, 0.25),
    imageBasedLighting: { name: "ibl-a" },
    backFaceCulling: true,
    shadows: 3,
    showCreditsOnScreen: false,
    splitDirection: 0,
    debugWireframe: false,
    edgeDisplayMode: 0,
    showOutline: true,
    outlineColor: Color.BLACK.clone(),
    pointCloudShading: { attenuation: true },
    clippingPlanes: undefined,
    clippingPlanesOriginMatrix: {},
    clippingPolygons: undefined,
    environmentMapManager: {},
  };
}

test("unchanged broad tileset state retains one immutable packet", () => {
  const tileset = makeTileset();
  const first = refreshModel3DTileStatePacket(tileset);
  const second = refreshModel3DTileStatePacket(tileset);

  assert.strictEqual(second, first);
  assert.equal(first.version, 1);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.lightColor), true);
  assert.notStrictEqual(first.lightColor, tileset.lightColor);
});

test("in-place cloned light state advances once without per-pass churn", () => {
  const tileset = makeTileset();
  const first = refreshModel3DTileStatePacket(tileset);

  tileset.lightColor.y = 0.75;
  const second = refreshModel3DTileStatePacket(tileset);
  const third = refreshModel3DTileStatePacket(tileset);

  assert.notStrictEqual(second, first);
  assert.equal(second.version, 2);
  assert.equal(second.lightColor.y, 0.75);
  assert.strictEqual(third, second);
});

test("null and undefined light state share one stable absent value", () => {
  const tileset = makeTileset();
  tileset.lightColor = null;

  const first = refreshModel3DTileStatePacket(tileset);
  const second = refreshModel3DTileStatePacket(tileset);
  tileset.lightColor = undefined;
  const third = refreshModel3DTileStatePacket(tileset);

  assert.equal(first.lightColor, undefined);
  assert.strictEqual(second, first);
  assert.strictEqual(third, first);
});

test("value-equal reference replacement advances the packet", () => {
  const tileset = makeTileset();
  const first = refreshModel3DTileStatePacket(tileset);

  tileset.outlineColor = tileset.outlineColor.clone();
  const second = refreshModel3DTileStatePacket(tileset);

  assert.notStrictEqual(second, first);
  assert.equal(second.version, 2);
  assert.strictEqual(second.outlineColor, tileset.outlineColor);
});

test("a complete packet catches a model up across skipped versions", () => {
  const tileset = makeTileset();
  const first = refreshModel3DTileStatePacket(tileset);
  tileset.colorBlendAmount = 0.75;
  refreshModel3DTileStatePacket(tileset);
  tileset.customShader = { name: "shader-c" };
  tileset.lightColor.x = 0.125;
  const third = refreshModel3DTileStatePacket(tileset);
  const model = {};

  applyModel3DTileStatePacket(model, third);

  assert.equal(third.version, first.version + 2);
  assert.equal(model.colorBlendAmount, 0.75);
  assert.strictEqual(model.customShader, tileset.customShader);
  assert.strictEqual(model.lightColor, third.lightColor);
  assert.equal(model.lightColor.x, 0.125);
  assert.strictEqual(model.imageBasedLighting, tileset.imageBasedLighting);
  assert.strictEqual(model.pointCloudShading, tileset.pointCloudShading);
  assert.strictEqual(model.outlineColor, tileset.outlineColor);
});

test("content uses packet identity while tileset preserves tileVisible mutation timing", () => {
  const contentSource = readFileSync(
    new URL(
      "../../packages/engine/Source/Scene/Model/Model3DTileContent.js",
      import.meta.url,
    ),
    "utf8",
  );
  const tilesetSource = readFileSync(
    new URL(
      "../../packages/engine/Source/Scene/Cesium3DTileset.js",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    contentSource,
    /if \(this\._modelStatePacket !== modelStatePacket\) \{\s*applyModel3DTileStatePacket\(model, modelStatePacket\);\s*this\._modelStatePacket = modelStatePacket;/,
  );
  assert.match(
    contentSource,
    /applyModel3DTileStatePacket[\s\S]*model\.modelMatrix = tile\.computedTransform;/,
  );
  assert.match(
    tilesetSource,
    /tileVisible\.raiseEvent\(tile\);\s*if \(tileVisibleCanMutateState\) \{\s*refreshModel3DTileStatePacket\(tileset\);/,
  );
  assert.match(
    tilesetSource,
    /const tiles = tileset\._processingQueue;[\s\S]{0,500}?if \(tiles\.length > 0\) \{\s*refreshModel3DTileStatePacket\(tileset\);/,
  );
  assert.match(
    tilesetSource,
    /tileLoad\.raiseEvent\(tile\);[\s\S]{0,300}?if \(tileLoadCanMutateState\) \{\s*refreshModel3DTileStatePacket\(tileset\);/,
  );
});

test("stable NaN scalar input is one packet state", () => {
  const tileset = makeTileset();
  tileset.colorBlendAmount = Number.NaN;

  const first = refreshModel3DTileStatePacket(tileset);
  const second = refreshModel3DTileStatePacket(tileset);

  assert.strictEqual(second, first);
  assert.equal(Number.isNaN(second.colorBlendAmount), true);
});
