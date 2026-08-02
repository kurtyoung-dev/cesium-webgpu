import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import Color from "../../../Source/Core/Color.js";
import {
  applyModel3DTileStatePacket,
  refreshModel3DTileStatePacket,
} from "../../../Source/Scene/Model/Model3DTileStatePacket.js";

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
  };
}

describe("Scene/Model/Model3DTileStatePacket", function () {
  it("retains one immutable packet while broad tileset state is unchanged", function () {
    const tileset = makeTileset();
    const first = refreshModel3DTileStatePacket(tileset);
    const second = refreshModel3DTileStatePacket(tileset);

    expect(second).toBe(first);
    expect(first.version).toBe(1);
    expect(Object.isFrozen(first)).toBeTrue();
    expect(Object.isFrozen(first.lightColor)).toBeTrue();
    expect(first.lightColor).not.toBe(tileset.lightColor);
  });

  it("bumps once for an in-place light edit and stays stable afterward", function () {
    const tileset = makeTileset();
    const first = refreshModel3DTileStatePacket(tileset);

    tileset.lightColor.y = 0.75;
    const second = refreshModel3DTileStatePacket(tileset);
    const third = refreshModel3DTileStatePacket(tileset);

    expect(second).not.toBe(first);
    expect(second.version).toBe(2);
    expect(second.lightColor.y).toBe(0.75);
    expect(third).toBe(second);
  });

  it("normalizes null and undefined light state without packet churn", function () {
    const tileset = makeTileset();
    tileset.lightColor = null;

    const first = refreshModel3DTileStatePacket(tileset);
    const second = refreshModel3DTileStatePacket(tileset);
    tileset.lightColor = undefined;
    const third = refreshModel3DTileStatePacket(tileset);

    expect(first.lightColor).toBeUndefined();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("bumps when a reference-valued renderer property is replaced", function () {
    const tileset = makeTileset();
    const first = refreshModel3DTileStatePacket(tileset);

    // A value-equal replacement must still advance: Model stores this object
    // by reference, and later in-place edits must reach every content.
    tileset.outlineColor = tileset.outlineColor.clone();
    const second = refreshModel3DTileStatePacket(tileset);

    expect(second).not.toBe(first);
    expect(second.version).toBe(2);
    expect(second.outlineColor).toBe(tileset.outlineColor);
  });

  it("applies a complete packet so a model may skip intermediate versions", function () {
    const tileset = makeTileset();
    const first = refreshModel3DTileStatePacket(tileset);
    tileset.colorBlendAmount = 0.75;
    refreshModel3DTileStatePacket(tileset);
    tileset.customShader = { name: "shader-c" };
    tileset.lightColor.x = 0.125;
    const third = refreshModel3DTileStatePacket(tileset);
    const model = {};

    applyModel3DTileStatePacket(model, third);

    expect(third.version).toBe(first.version + 2);
    expect(model.colorBlendAmount).toBe(0.75);
    expect(model.customShader).toBe(tileset.customShader);
    expect(model.lightColor).toBe(third.lightColor);
    expect(model.lightColor.x).toBe(0.125);
    expect(model.imageBasedLighting).toBe(tileset.imageBasedLighting);
    expect(model.pointCloudShading).toBe(tileset.pointCloudShading);
    expect(model.outlineColor).toBe(tileset.outlineColor);
  });

  it("treats stable NaN scalar input as one state instead of per-pass churn", function () {
    const tileset = makeTileset();
    tileset.colorBlendAmount = Number.NaN;

    const first = refreshModel3DTileStatePacket(tileset);
    const second = refreshModel3DTileStatePacket(tileset);

    expect(second).toBe(first);
    expect(Number.isNaN(second.colorBlendAmount)).toBeTrue();
  });
});
