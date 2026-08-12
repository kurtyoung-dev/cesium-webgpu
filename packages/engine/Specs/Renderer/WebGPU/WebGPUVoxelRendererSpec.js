import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import Matrix4 from "../../../Source/Core/Matrix4.js";
import {
  computeVoxelProxyFirstIndex,
  createVoxelProxyIndices,
  updateVoxelProxyCommandFirstIndices,
} from "../../../Source/Renderer/WebGPU/WebGPUVoxelRenderer.js";

describe("Renderer/WebGPU/WebGPUVoxelRenderer", function () {
  const originalIndices = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 2, 6, 7, 2, 7, 3, 0,
    3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ];

  function worldPoint(modelMatrix, proxyPoint) {
    return Matrix4.multiplyByPoint(modelMatrix, proxyPoint, new Cartesian3());
  }

  function select(modelMatrix, cameraWorld, result = new Cartesian3()) {
    return computeVoxelProxyFirstIndex(modelMatrix, cameraWorld, result);
  }

  it("preserves the original index prefix and reverses every appended triangle", function () {
    const indices = createVoxelProxyIndices();
    expect(indices).toBeInstanceOf(Uint16Array);
    expect(indices.length).toBe(72);
    expect(Array.from(indices.slice(0, 36))).toEqual(originalIndices);

    for (let i = 0; i < 36; i += 3) {
      expect(Array.from(indices.slice(36 + i, 36 + i + 3))).toEqual([
        originalIndices[i],
        originalIndices[i + 2],
        originalIndices[i + 1],
      ]);
    }
  });

  it("uses an inclusive epsilon at every proxy face", function () {
    const limit = 0.5 + 1.0e-7;
    const points = [
      Cartesian3.ZERO,
      new Cartesian3(limit, 0.0, 0.0),
      new Cartesian3(-limit, 0.0, 0.0),
      new Cartesian3(0.0, limit, 0.0),
      new Cartesian3(0.0, -limit, 0.0),
      new Cartesian3(0.0, 0.0, limit),
      new Cartesian3(0.0, 0.0, -limit),
      new Cartesian3(limit, -limit, limit),
    ];

    for (const point of points) {
      expect(select(Matrix4.IDENTITY, point)).toBe(36);
    }
    expect(
      select(Matrix4.IDENTITY, new Cartesian3(limit + 1.0e-10, 0.0, 0.0)),
    ).toBe(0);
  });

  it("classifies through the exact translated, scaled, and sheared effective model", function () {
    const model = new Matrix4(
      2.0,
      0.5,
      0.0,
      10.0,
      0.0,
      3.0,
      0.25,
      -4.0,
      0.0,
      0.0,
      4.0,
      7.0,
      0.0,
      0.0,
      0.0,
      1.0,
    );
    const insideProxy = new Cartesian3(0.4, -0.3, 0.2);
    const outsideProxy = new Cartesian3(0.6, -0.3, 0.2);
    const recovered = new Cartesian3();

    expect(select(model, worldPoint(model, insideProxy), recovered)).toBe(36);
    expect(recovered).toEqualEpsilon(insideProxy, 1.0e-14);
    expect(select(model, worldPoint(model, outsideProxy), recovered)).toBe(0);
    expect(recovered).toEqualEpsilon(outsideProxy, 1.0e-14);
  });

  it("exclusive-ors camera containment with mirrored model winding", function () {
    const translated = Matrix4.fromTranslation(
      new Cartesian3(10.0, -20.0, 30.0),
      new Matrix4(),
    );
    const mirrored = Matrix4.multiplyByScale(
      translated,
      new Cartesian3(-2.0, 3.0, 4.0),
      new Matrix4(),
    );
    const doubleMirrored = Matrix4.multiplyByScale(
      translated,
      new Cartesian3(-2.0, -3.0, 4.0),
      new Matrix4(),
    );
    const inside = new Cartesian3(0.0, 0.0, 0.0);
    const outside = new Cartesian3(0.75, 0.0, 0.0);

    expect(select(mirrored, worldPoint(mirrored, inside))).toBe(0);
    expect(select(mirrored, worldPoint(mirrored, outside))).toBe(36);
    expect(select(doubleMirrored, worldPoint(doubleMirrored, inside))).toBe(36);
    expect(select(doubleMirrored, worldPoint(doubleMirrored, outside))).toBe(0);
  });

  it("fails closed for non-finite cameras and degenerate transforms", function () {
    for (const point of [
      new Cartesian3(Number.NaN, 0.0, 0.0),
      new Cartesian3(0.0, Number.POSITIVE_INFINITY, 0.0),
      new Cartesian3(0.0, 0.0, Number.NEGATIVE_INFINITY),
    ]) {
      const result = new Cartesian3(1.0, 1.0, 1.0);
      expect(select(Matrix4.IDENTITY, point, result)).toBe(0);
      expect(result).toEqual(Cartesian3.ZERO);
    }

    const zeroScale = Matrix4.fromScale(
      new Cartesian3(0.0, 1.0, 1.0),
      new Matrix4(),
    );
    const result = new Cartesian3(1.0, 1.0, 1.0);
    expect(select(zeroScale, Cartesian3.ZERO, result)).toBe(0);
    expect(result).toEqual(Cartesian3.ZERO);

    const nonFiniteModel = Matrix4.clone(Matrix4.IDENTITY, new Matrix4());
    nonFiniteModel[0] = Number.NaN;
    expect(select(nonFiniteModel, Cartesian3.ZERO, result)).toBe(0);
    expect(result).toEqual(Cartesian3.ZERO);
  });

  it("updates every current and lazily-added command without replacement", function () {
    const color = { firstIndex: -1 };
    const objectPick = { firstIndex: -1 };
    const commands = {
      command: color,
      pickCommand: objectPick,
      pickVoxelCommand: null,
    };

    updateVoxelProxyCommandFirstIndices(commands, 0);
    expect(color.firstIndex).toBe(0);
    expect(objectPick.firstIndex).toBe(0);

    const velocity = { firstIndex: -1 };
    const cellPick = { firstIndex: -1 };
    color.velocityCommand = velocity;
    commands.pickVoxelCommand = cellPick;
    updateVoxelProxyCommandFirstIndices(commands, 36);
    expect(color.firstIndex).toBe(36);
    expect(objectPick.firstIndex).toBe(36);
    expect(cellPick.firstIndex).toBe(36);
    expect(velocity.firstIndex).toBe(36);

    updateVoxelProxyCommandFirstIndices(commands, 0);
    expect(color.firstIndex).toBe(0);
    expect(objectPick.firstIndex).toBe(0);
    expect(cellPick.firstIndex).toBe(0);
    expect(velocity.firstIndex).toBe(0);
    expect(commands.command).toBe(color);
    expect(commands.pickCommand).toBe(objectPick);
    expect(commands.pickVoxelCommand).toBe(cellPick);
  });
});
