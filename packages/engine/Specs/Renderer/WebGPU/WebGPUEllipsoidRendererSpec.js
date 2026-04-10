import {
  ELLIPSOID_BASE_UNIFORM_FLOATS,
  ELLIPSOID_BASE_UNIFORM_BYTES,
  packEllipsoidBaseUniforms,
} from "../../../Source/Renderer/WebGPU/WebGPUEllipsoidRenderer.js";
import Cartesian3 from "../../../Source/Core/Cartesian3.js";

// Helpers — small fixtures used across multiple specs.
function makeIdentityMVP() {
  // 16-element identity matrix (column-major).
  const m = new Float64Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function makeBaseInputs(overrides) {
  // A neutral inputs struct: identity transforms, camera at origin,
  // body centered at (1e7, 0, 0). The shared packer should produce
  // deterministic byte writes for this exact input on every run.
  return {
    mvpRelativeToEye: makeIdentityMVP(),
    viewMatrix: makeIdentityMVP(),
    cameraPositionWC: new Cartesian3(0, 0, 0),
    modelMatrix: (() => {
      // Identity rotation, translation = (1e7, 0, 0).
      const m = makeIdentityMVP();
      m[12] = 1e7;
      m[13] = 0;
      m[14] = 0;
      return m;
    })(),
    radii: { x: 1737, y: 1737, z: 1735 },
    oneOverRadiiSquared: {
      x: 1 / (1737 * 1737),
      y: 1 / (1737 * 1737),
      z: 1 / (1735 * 1735),
    },
    sunDirectionWC: new Cartesian3(1, 0, 0),
    ...overrides,
  };
}

describe("Renderer/WebGPU/WebGPUEllipsoidRenderer", function () {
  describe("base uniform layout constants", function () {
    it("reserves exactly 64 floats for the body-agnostic prefix", function () {
      expect(ELLIPSOID_BASE_UNIFORM_FLOATS).toBe(64);
    });

    it("reports 256 bytes (matches a 256-aligned UBO slot)", function () {
      expect(ELLIPSOID_BASE_UNIFORM_BYTES).toBe(256);
      expect(ELLIPSOID_BASE_UNIFORM_BYTES).toBe(
        ELLIPSOID_BASE_UNIFORM_FLOATS * 4,
      );
    });
  });

  describe("packEllipsoidBaseUniforms", function () {
    it("writes the mvpRelativeToEye matrix at offsets 0..15", function () {
      const ud = new Float32Array(80);
      const inputs = makeBaseInputs();
      // Use a recognizable, non-identity matrix so we can verify the
      // exact column-major layout.
      const mvp = new Float64Array(16);
      for (let i = 0; i < 16; i++) {
        mvp[i] = i + 1;
      }
      inputs.mvpRelativeToEye = mvp;
      packEllipsoidBaseUniforms(ud, inputs);
      for (let i = 0; i < 16; i++) {
        expect(ud[i]).toBeCloseTo(i + 1, 5);
      }
    });

    it("writes encodedCamera high+low into offsets 16..23", function () {
      const ud = new Float32Array(80);
      const inputs = makeBaseInputs({
        cameraPositionWC: new Cartesian3(1e7, 2e7, 3e7),
      });
      packEllipsoidBaseUniforms(ud, inputs);
      // The split is f32 high + f32 low — the SUM of high and low must
      // recover the original f64 to within float32 precision.
      const highX = ud[16];
      const lowX = ud[20];
      expect(highX + lowX).toBeCloseTo(1e7, 0);
      expect(ud[19]).toBe(0); // pad
      expect(ud[23]).toBe(0); // pad
    });

    it("writes encodedCenter from the model matrix translation column", function () {
      const ud = new Float32Array(80);
      const inputs = makeBaseInputs();
      // The base inputs put the body at (1e7, 0, 0) via modelMatrix[12..14].
      packEllipsoidBaseUniforms(ud, inputs);
      const highX = ud[24];
      const lowX = ud[28];
      expect(highX + lowX).toBeCloseTo(1e7, 0);
      expect(ud[25]).toBe(0); // y high
      expect(ud[26]).toBe(0); // z high
    });

    it("writes radii at offsets 48..51", function () {
      const ud = new Float32Array(80);
      const inputs = makeBaseInputs({
        radii: { x: 100, y: 200, z: 300 },
      });
      packEllipsoidBaseUniforms(ud, inputs);
      expect(ud[48]).toBe(100);
      expect(ud[49]).toBe(200);
      expect(ud[50]).toBe(300);
      expect(ud[51]).toBe(0);
    });

    it("writes oneOverRadiiSquared at offsets 52..55", function () {
      const ud = new Float32Array(80);
      const inputs = makeBaseInputs({
        oneOverRadiiSquared: { x: 0.01, y: 0.04, z: 0.09 },
      });
      packEllipsoidBaseUniforms(ud, inputs);
      expect(ud[52]).toBeCloseTo(0.01, 6);
      expect(ud[53]).toBeCloseTo(0.04, 6);
      expect(ud[54]).toBeCloseTo(0.09, 6);
      expect(ud[55]).toBe(0);
    });

    it("writes sunDirMC at offsets 56..58 (with .w left zero for body-specific use)", function () {
      const ud = new Float32Array(80);
      // Identity model matrix → world == model space → sun direction
      // unchanged.
      const inputs = makeBaseInputs({
        sunDirectionWC: new Cartesian3(0, 1, 0),
      });
      packEllipsoidBaseUniforms(ud, inputs);
      expect(ud[56]).toBeCloseTo(0, 6);
      expect(ud[57]).toBeCloseTo(1, 6);
      expect(ud[58]).toBeCloseTo(0, 6);
      // ud[59] is reserved for body-specific flags (e.g. onlySunLighting);
      // the base packer must leave it untouched (the test framework
      // pre-fills with zero).
      expect(ud[59]).toBe(0);
    });

    it("falls back to sunDirectionWC when sceneLightDirectionWC is omitted", function () {
      const ud = new Float32Array(80);
      const inputs = makeBaseInputs({
        sunDirectionWC: new Cartesian3(1, 0, 0),
      });
      packEllipsoidBaseUniforms(ud, inputs);
      // Both sun (offsets 56..58) and scene light (60..62) should equal
      // the sun direction since no separate scene light was supplied.
      expect(ud[56]).toBeCloseTo(1, 6);
      expect(ud[60]).toBeCloseTo(1, 6);
      expect(ud[57]).toBeCloseTo(0, 6);
      expect(ud[61]).toBeCloseTo(0, 6);
    });

    it("uses sceneLightDirectionWC when supplied (e.g. MoonLight scenes)", function () {
      const ud = new Float32Array(80);
      const inputs = makeBaseInputs({
        sunDirectionWC: new Cartesian3(1, 0, 0),
        sceneLightDirectionWC: new Cartesian3(0, 0, 1),
      });
      packEllipsoidBaseUniforms(ud, inputs);
      // Sun slot still gets the sun direction.
      expect(ud[56]).toBeCloseTo(1, 6);
      // Scene light slot gets the alternate direction.
      expect(ud[60]).toBeCloseTo(0, 6);
      expect(ud[61]).toBeCloseTo(0, 6);
      expect(ud[62]).toBeCloseTo(1, 6);
    });

    it("transforms the sun direction by inverse model rotation when the model is rotated", function () {
      // 90° rotation around Z: model X axis points toward world Y.
      // Sun pointing along world Y should land on model X.
      const m = new Float64Array(16);
      // Column 0 = (cos90, sin90, 0, 0) = (0, 1, 0, 0)
      m[0] = 0;
      m[1] = 1;
      // Column 1 = (-sin90, cos90, 0, 0) = (-1, 0, 0, 0)
      m[4] = -1;
      m[5] = 0;
      // Column 2 = (0, 0, 1, 0)
      m[10] = 1;
      // Column 3 = translation (0,0,0,1)
      m[15] = 1;

      const ud = new Float32Array(80);
      packEllipsoidBaseUniforms(ud, {
        ...makeBaseInputs(),
        modelMatrix: m,
        sunDirectionWC: new Cartesian3(0, 1, 0),
      });
      // After inverse-rotating world (0,1,0) by the 90° Z model rotation,
      // we expect (1, 0, 0) in model space.
      expect(ud[56]).toBeCloseTo(1, 5);
      expect(ud[57]).toBeCloseTo(0, 5);
      expect(ud[58]).toBeCloseTo(0, 5);
    });

    it("computes camera position in model coordinates via the inverse model matrix", function () {
      // Model matrix: identity rotation + translation (10, 20, 30).
      // Camera at world origin → camera in model space at (-10, -20, -30).
      const m = new Float64Array(16);
      m[0] = 1;
      m[5] = 1;
      m[10] = 1;
      m[12] = 10;
      m[13] = 20;
      m[14] = 30;
      m[15] = 1;
      const ud = new Float32Array(80);
      packEllipsoidBaseUniforms(ud, {
        ...makeBaseInputs(),
        modelMatrix: m,
        cameraPositionWC: new Cartesian3(0, 0, 0),
      });
      expect(ud[44]).toBeCloseTo(-10, 5);
      expect(ud[45]).toBeCloseTo(-20, 5);
      expect(ud[46]).toBeCloseTo(-30, 5);
      expect(ud[47]).toBe(0);
    });

    it("does not write past offset 63 — body-specific tail is left untouched", function () {
      const ud = new Float32Array(80);
      // Pre-fill the tail with a sentinel so we can verify it's not
      // overwritten by the base packer.
      for (let i = 64; i < 80; i++) {
        ud[i] = -999;
      }
      packEllipsoidBaseUniforms(ud, makeBaseInputs());
      for (let i = 64; i < 80; i++) {
        expect(ud[i]).toBe(-999);
      }
    });
  });

  // Note: createEllipsoidBoundingCube and createEllipsoidBindGroupLayout
  // require a real GPUDevice and are exercised end-to-end through the
  // Moon renderer. Adding mock-device specs here would duplicate the
  // WebGPURingBufferAllocatorSpec mock pattern; deferred until a future
  // ellipsoid body lands a second consumer to validate the bounding-cube
  // sharing in isolation.
});
