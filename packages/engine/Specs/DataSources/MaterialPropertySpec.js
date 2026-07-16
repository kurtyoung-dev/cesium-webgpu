import { Color, Material, MaterialProperty } from "../../index.js";

describe("DataSources/MaterialProperty", function () {
  it("clones the fallback color into the existing public uniform value", function () {
    const material = Material.fromType(Material.ColorType);
    const color = material.uniforms.color;

    const result = MaterialProperty.getValue(undefined, undefined, material);

    expect(result).toBe(material);
    expect(material.uniforms.color).toBe(color);
    expect(material.uniforms.color).toEqual(Color.WHITE);
    expect(material._uniformBuffer.gpuData[3]).toBe(1.0);
  });

  it("allows a property to clone into an existing material result", function () {
    const expected = new Color(0.25, 0.5, 0.75, 0.125);
    const material = Material.fromType(Material.ColorType);
    const color = material.uniforms.color;
    const property = {
      getType: function () {
        return Material.ColorType;
      },
      getValue: function (time, result) {
        result.color = Color.clone(expected, result.color);
        return result;
      },
    };

    const result = MaterialProperty.getValue(undefined, property, material);

    expect(result).toBe(material);
    expect(material.uniforms.color).toBe(color);
    expect(material.uniforms.color).toEqual(expected);
    expect(material._uniformBuffer.gpuData[3]).toBeCloseTo(0.125);
  });
});
