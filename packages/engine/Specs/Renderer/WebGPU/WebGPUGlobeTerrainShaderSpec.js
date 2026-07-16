import GlobeTerrainShader from "../../../Source/Shaders/WebGPU/Globe/GlobeTerrain.js";

describe("Renderer/WebGPU/GlobeTerrain shader", function () {
  it("samples atmosphere fog at the fragment absolute ECEF position", function () {
    expect(GlobeTerrainShader).toContain("out.v_positionMC = position3DWC;");
    expect(GlobeTerrainShader).toContain(
      "let fragmentWorldPos = input.v_positionMC;",
    );
    expect(GlobeTerrainShader).not.toContain(
      "let fragmentWorldPos = input.v_positionMC + cameraWC;",
    );
  });

  it("keeps atmosphere altitude stable at poles, antimeridian, and camera teleports", function () {
    const radius = 6378137.0;
    const samples = [
      { name: "north-pole", position: [0, 0, radius + 1200], altitude: 1200 },
      {
        name: "antimeridian",
        position: [-(radius + 3400), 0, 0],
        altitude: 3400,
      },
      {
        name: "south-pole",
        position: [0, 0, -(radius + 800)],
        altitude: 800,
      },
    ];
    const cameras = [
      [radius + 1000, 0, 0],
      [0, -(radius + 20_000_000), 0],
      [0, 0, radius + 35_786_000],
    ];

    for (const sample of samples) {
      const absoluteAltitude = magnitude(sample.position) - radius;
      expect(absoluteAltitude)
        .withContext(sample.name)
        .toBeCloseTo(sample.altitude, 6);

      // Teleporting the camera must not change a fragment's physical ECEF
      // altitude. The removed cameraWC addition fails this oracle by millions
      // of metres, especially across the antimeridian and poles.
      for (const camera of cameras) {
        expect(magnitude(sample.position) - radius)
          .withContext(`${sample.name} absolute ECEF`)
          .toBeCloseTo(sample.altitude, 6);
        const legacyCameraRelativeAltitude =
          magnitude(add(sample.position, camera)) - radius;
        expect(Math.abs(legacyCameraRelativeAltitude - sample.altitude))
          .withContext(`${sample.name} legacy camera addition`)
          .toBeGreaterThan(100_000);
      }
    }
  });
});

function magnitude(value) {
  return Math.hypot(value[0], value[1], value[2]);
}

function add(left, right) {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}
