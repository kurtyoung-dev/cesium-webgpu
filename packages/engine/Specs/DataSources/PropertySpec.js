import {
  Cartesian2,
  Color,
  JulianDate,
  TimeInterval,
  CompositeProperty,
  ConstantProperty,
  PolylineGlowMaterialProperty,
  Property,
  SampledProperty,
  TimeIntervalCollectionProperty,
} from "../../index.js";

describe("DataSources/Property", function () {
  const start = JulianDate.fromIso8601("2012-08-01T00:00:00Z");
  const stop = JulianDate.fromIso8601("2012-08-02T00:00:00Z");

  function intervalProperty(data) {
    const property = new TimeIntervalCollectionProperty();
    property.intervals.addInterval(
      new TimeInterval({
        start: start,
        stop: stop,
        data: data,
      }),
    );
    return property;
  }

  it("equals returns true for the same instance and for two undefined values", function () {
    const property = new ConstantProperty(5);
    expect(Property.equals(property, property)).toBe(true);
    expect(Property.equals(undefined, undefined)).toBe(true);
  });

  it("equals returns false when only one side is defined", function () {
    const property = new ConstantProperty(5);
    expect(Property.equals(undefined, property)).toBe(false);
    expect(Property.equals(property, undefined)).toBe(false);
  });

  it("equals delegates to the left operand's equals method", function () {
    expect(
      Property.equals(new ConstantProperty(5), new ConstantProperty(5)),
    ).toBe(true);
    expect(
      Property.equals(new ConstantProperty(5), new ConstantProperty(6)),
    ).toBe(false);
  });

  it("equals returns a boolean for values that have no equals method", function () {
    expect(Property.equals(0.25, 0.5)).toBe(false);
    expect(Property.equals(0.25, 0.25)).toBe(true);
    expect(Property.equals(true, false)).toBe(false);
    expect(Property.equals("a", "b")).toBe(false);
    expect(Property.equals(0.25, new ConstantProperty(0.25))).toBe(false);
  });

  it("equals compares interval collections holding primitive data without throwing", function () {
    expect(Property.equals(intervalProperty(0.25), intervalProperty(0.5))).toBe(
      false,
    );
    expect(
      Property.equals(intervalProperty(0.25), intervalProperty(0.25)),
    ).toBe(true);
    expect(
      Property.equals(intervalProperty(true), intervalProperty(false)),
    ).toBe(false);
    expect(Property.equals(intervalProperty("a"), intervalProperty("b"))).toBe(
      false,
    );
  });

  it("material properties holding interval collections of numbers compare without throwing", function () {
    const left = new PolylineGlowMaterialProperty();
    left.glowPower = intervalProperty(0.25);

    const right = new PolylineGlowMaterialProperty();
    right.glowPower = intervalProperty(0.5);

    expect(left.equals(right)).toBe(false);

    right.glowPower = intervalProperty(0.25);
    expect(left.equals(right)).toBe(true);
  });

  it("arrayEquals compares element by element", function () {
    const left = [new ConstantProperty(1), new ConstantProperty(2)];
    const right = [new ConstantProperty(1), new ConstantProperty(2)];

    expect(Property.arrayEquals(left, left)).toBe(true);
    expect(Property.arrayEquals(left, right)).toBe(true);
    expect(Property.arrayEquals(left, [new ConstantProperty(1)])).toBe(false);
    expect(Property.arrayEquals(left, undefined)).toBe(false);
    expect(Property.arrayEquals(undefined, undefined)).toBe(true);
  });

  it("arrayEquals compares primitive elements without throwing", function () {
    expect(Property.arrayEquals([0.25, 0.5], [0.25, 0.5])).toBe(true);
    expect(Property.arrayEquals([0.25, 0.5], [0.25, 0.75])).toBe(false);
  });

  it("isConstant treats an undefined property as constant", function () {
    expect(Property.isConstant(undefined)).toBe(true);
    expect(Property.isConstant(new ConstantProperty(5))).toBe(true);

    const composite = new CompositeProperty();
    composite.intervals.addInterval(
      new TimeInterval({
        start: start,
        stop: stop,
        data: new ConstantProperty(5),
      }),
    );
    expect(Property.isConstant(composite)).toBe(false);
  });

  it("getValueOrUndefined returns undefined for an undefined property", function () {
    expect(Property.getValueOrUndefined(undefined, start)).toBeUndefined();
    expect(
      Property.getValueOrUndefined(new ConstantProperty(5), start),
    ).toEqual(5);
  });

  it("getValueOrUndefined passes the result parameter through", function () {
    const result = new Cartesian2();
    const property = new ConstantProperty(new Cartesian2(1, 2));
    expect(Property.getValueOrUndefined(property, start, result)).toBe(result);
    expect(result).toEqual(new Cartesian2(1, 2));
  });

  it("getValueOrDefault falls back to the default", function () {
    expect(Property.getValueOrDefault(undefined, start, 7)).toEqual(7);
    expect(
      Property.getValueOrDefault(new ConstantProperty(5), start, 7),
    ).toEqual(5);

    const sampled = new SampledProperty(Number);
    expect(Property.getValueOrDefault(sampled, start, 7)).toEqual(7);
  });

  it("getValueOrClonedDefault writes the default into the supplied result", function () {
    const result = new Color();
    const value = Property.getValueOrClonedDefault(
      undefined,
      start,
      Color.WHITE,
      result,
    );

    expect(value).toBe(result);
    expect(value).toEqual(Color.WHITE);
    expect(Color.WHITE).toEqual(new Color(1.0, 1.0, 1.0, 1.0));
  });

  it("getValueOrClonedDefault reuses the result across repeated calls", function () {
    const result = new Color();
    const first = Property.getValueOrClonedDefault(
      undefined,
      start,
      Color.WHITE,
      result,
    );
    const second = Property.getValueOrClonedDefault(
      undefined,
      start,
      Color.RED,
      result,
    );

    expect(first).toBe(second);
    expect(second).toEqual(Color.RED);
  });

  it("getValueOrClonedDefault allocates when no result is supplied", function () {
    const value = Property.getValueOrClonedDefault(
      undefined,
      start,
      Color.WHITE,
    );

    expect(value).toEqual(Color.WHITE);
    expect(value).not.toBe(Color.WHITE);
  });

  it("getValueOrClonedDefault returns the property value when one is available", function () {
    const result = new Color();
    const property = new ConstantProperty(Color.RED);
    const value = Property.getValueOrClonedDefault(
      property,
      start,
      Color.WHITE,
      result,
    );

    expect(value).toBe(result);
    expect(value).toEqual(Color.RED);
  });
});
