// @purpose Pins the observable contract of the DataSources property helpers: comparison of properties whose interval data has no equals method, reuse of the caller's destination in getValueOrClonedDefault, and the isConstant terms the PathMode.PORTIONS branch reads.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import Color from "../../packages/engine/Source/Core/Color.js";
import JulianDate from "../../packages/engine/Source/Core/JulianDate.js";
import TimeInterval from "../../packages/engine/Source/Core/TimeInterval.js";
import ConstantProperty from "../../packages/engine/Source/DataSources/ConstantProperty.js";
import ImageMaterialProperty from "../../packages/engine/Source/DataSources/ImageMaterialProperty.js";
import PathGraphics from "../../packages/engine/Source/DataSources/PathGraphics.js";
import PathMode from "../../packages/engine/Source/DataSources/PathMode.js";
import PolylineGlowMaterialProperty from "../../packages/engine/Source/DataSources/PolylineGlowMaterialProperty.js";
import Property from "../../packages/engine/Source/DataSources/Property.js";
import SampledProperty from "../../packages/engine/Source/DataSources/SampledProperty.js";
import TimeIntervalCollectionProperty from "../../packages/engine/Source/DataSources/TimeIntervalCollectionProperty.js";

const specDirectory = path.dirname(fileURLToPath(import.meta.url));
const engineSource = path.join(
  specDirectory,
  "..",
  "..",
  "packages",
  "engine",
  "Source",
);

const start = JulianDate.fromIso8601("2012-08-01T00:00:00Z");
const stop = JulianDate.fromIso8601("2012-08-02T00:00:00Z");

function intervalProperty(data) {
  const property = new TimeIntervalCollectionProperty();
  property.intervals.addInterval(
    new TimeInterval({ start: start, stop: stop, data: data }),
  );
  return property;
}

function sampledColor() {
  const sampled = new SampledProperty(Color);
  sampled.addSample(start, Color.RED);
  sampled.addSample(stop, Color.BLUE);
  return sampled;
}

test("Property.equals compares interval collections of primitive data without throwing", () => {
  assert.equal(
    Property.equals(intervalProperty(0.25), intervalProperty(0.5)),
    false,
  );
  assert.equal(
    Property.equals(intervalProperty(0.25), intervalProperty(0.25)),
    true,
  );
  assert.equal(
    Property.equals(intervalProperty(true), intervalProperty(false)),
    false,
  );
  assert.equal(
    Property.equals(intervalProperty("a"), intervalProperty("b")),
    false,
  );
});

test("Property.equals returns a boolean for operands that have no equals method", () => {
  assert.equal(Property.equals(0.25, 0.5), false);
  assert.equal(Property.equals(0.25, 0.25), true);
  assert.equal(Property.equals(true, false), false);
  assert.equal(Property.equals(0.25, new ConstantProperty(0.25)), false);
});

test("Property.equals still delegates to a left operand that has one", () => {
  const property = new ConstantProperty(5);
  assert.equal(Property.equals(property, property), true);
  assert.equal(
    Property.equals(new ConstantProperty(5), new ConstantProperty(5)),
    true,
  );
  assert.equal(
    Property.equals(new ConstantProperty(5), new ConstantProperty(6)),
    false,
  );
  assert.equal(Property.equals(undefined, undefined), true);
  assert.equal(Property.equals(undefined, property), false);
});

test("material batching compares glow materials whose sub-property holds interval numbers", () => {
  const left = new PolylineGlowMaterialProperty();
  left.glowPower = intervalProperty(0.25);

  const right = new PolylineGlowMaterialProperty();
  right.glowPower = intervalProperty(0.5);

  assert.equal(left.equals(right), false);

  right.glowPower = intervalProperty(0.25);
  assert.equal(left.equals(right), true);
});

test("getValueOrClonedDefault writes the default into the caller's destination", () => {
  const result = new Color();
  const first = Property.getValueOrClonedDefault(
    undefined,
    start,
    Color.WHITE,
    result,
  );
  assert.equal(first, result);
  assert.deepEqual(
    [first.red, first.green, first.blue, first.alpha],
    [1.0, 1.0, 1.0, 1.0],
  );

  const second = Property.getValueOrClonedDefault(
    undefined,
    start,
    Color.RED,
    result,
  );
  assert.equal(second, first);
  assert.deepEqual(
    [second.red, second.green, second.blue, second.alpha],
    [Color.RED.red, Color.RED.green, Color.RED.blue, Color.RED.alpha],
  );
});

test("getValueOrClonedDefault still allocates when no destination is supplied", () => {
  const value = Property.getValueOrClonedDefault(undefined, start, Color.WHITE);
  assert.notEqual(value, Color.WHITE);
  assert.equal(Color.equals(value, Color.WHITE), true);
});

test("getValueOrClonedDefault returns the property's own value when there is one", () => {
  const result = new Color();
  const value = Property.getValueOrClonedDefault(
    new ConstantProperty(Color.RED),
    start,
    Color.WHITE,
    result,
  );
  assert.equal(value, result);
  assert.equal(Color.equals(value, Color.RED), true);
});

test("ImageMaterialProperty.isConstant reports every field it compares in equals", () => {
  const constant = new ImageMaterialProperty({
    image: "test.invalid",
    color: Color.RED,
    transparent: true,
  });
  assert.equal(constant.isConstant, true);

  const animatedColor = new ImageMaterialProperty({ image: "test.invalid" });
  animatedColor.color = sampledColor();
  assert.equal(animatedColor.isConstant, false);

  const animatedTransparent = new ImageMaterialProperty({
    image: "test.invalid",
  });
  animatedTransparent.transparent = intervalProperty(true);
  assert.equal(animatedTransparent.isConstant, false);
});

// PathVisualizer.js cannot be imported without a build: it reaches
// Scene/PolylineCollection.js, which imports the generated Shaders/ modules.
// The branch condition is therefore lifted from the shipped source and
// evaluated against real operands, so a moved or reworded consumer fails here
// rather than passing silently.
function pathPortionsCondition() {
  const source = fs.readFileSync(
    path.join(engineSource, "DataSources", "PathVisualizer.js"),
    "utf8",
  );
  const lines = source.split(/\r?\n/);
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const match =
      /^\s*if \((materialMode === PathMode\.PORTIONS .*)\) \{$/.exec(lines[i]);
    if (match !== null) {
      matches.push({ line: i + 1, condition: match[1] });
    }
  }
  assert.equal(
    matches.length,
    1,
    `expected exactly one PathMode.PORTIONS branch in PathVisualizer.js, found ${matches.length}`,
  );
  return {
    line: matches[0].line,
    evaluate: vm.compileFunction(`return (${matches[0].condition});`, [
      "materialMode",
      "PathMode",
      "materialProp",
    ]),
  };
}

test("the PathVisualizer PORTIONS branch is entered for an animated image material", () => {
  const branch = pathPortionsCondition();
  const graphics = new PathGraphics({ materialMode: PathMode.PORTIONS });
  const materialMode = Property.getValueOrUndefined(
    graphics.materialMode,
    start,
  );
  assert.equal(materialMode, PathMode.PORTIONS);

  const animated = new ImageMaterialProperty({ image: "test.invalid" });
  animated.color = sampledColor();
  assert.equal(
    branch.evaluate(materialMode, PathMode, animated),
    true,
    `PathVisualizer.js:${branch.line} did not split an animated image material into portions`,
  );

  const constant = new ImageMaterialProperty({
    image: "test.invalid",
    color: Color.RED,
  });
  assert.equal(branch.evaluate(materialMode, PathMode, constant), false);
  assert.equal(
    branch.evaluate(PathMode.WHOLE, PathMode, animated),
    false,
    "the branch must stay closed outside PORTIONS mode",
  );
});
