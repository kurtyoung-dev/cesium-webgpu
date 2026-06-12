// GPUShaderStage must exist before the helpers module is evaluated, because
// `Stage` is computed from GPUShaderStage flags at module-load time (unlike
// the reflection helpers, which read the global lazily at call time). Karma
// runs under Edge/Chromium where GPUShaderStage is a real WebGPU global, but
// we install spec-valued constants as a fallback so the import resolves even
// when WebGPU isn't present. This block executes before the import below is
// *used* at runtime, and the spec values match the WebGPU specification so a
// real GPUShaderStage and this fallback produce identical numbers either way.
if (typeof globalThis.GPUShaderStage === "undefined") {
  globalThis.GPUShaderStage = {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
  };
}

import {
  Stage,
  uniformBuffer,
  storageBuffer,
  texture,
  storageTexture,
  sampler,
  makeBindGroupLayout,
} from "../../../Source/Renderer/WebGPU/WebGPUBindGroupLayoutHelpers.js";

describe("Renderer/WebGPU/WebGPUBindGroupLayoutHelpers", function () {
  // The entry builders are pure functions that return plain
  // GPUBindGroupLayoutEntry descriptor objects. They need no GPU device, no
  // queue, and no async setup — exactly the low-cost coverage we want from a
  // Karma run so an accidental edit to a default (e.g. texture sampleType
  // flipping from "float" to "depth") fails fast in CI instead of producing a
  // mismatched bind-group layout at draw time.

  describe("Stage", function () {
    // GPUShaderStage spec values: VERTEX=1, FRAGMENT=2, COMPUTE=4. The Stage
    // shorthands are bitwise OR combinations of those, so we assert both the
    // concrete spec numbers and the relational identity (combination ===
    // OR-of-parts) so the test holds against either a real GPUShaderStage or
    // the fallback installed above.
    it("exposes the single-stage shorthands", function () {
      expect(Stage.COMPUTE).toBe(GPUShaderStage.COMPUTE);
      expect(Stage.VERTEX).toBe(GPUShaderStage.VERTEX);
      expect(Stage.FRAGMENT).toBe(GPUShaderStage.FRAGMENT);
    });

    it("computes VERTEX_FRAGMENT as VERTEX | FRAGMENT", function () {
      expect(Stage.VERTEX_FRAGMENT).toBe(
        GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      );
      // 1 | 2 === 3 under spec values.
      expect(Stage.VERTEX_FRAGMENT).toBe(3);
    });

    it("computes ALL as COMPUTE | VERTEX | FRAGMENT", function () {
      expect(Stage.ALL).toBe(
        GPUShaderStage.COMPUTE |
          GPUShaderStage.VERTEX |
          GPUShaderStage.FRAGMENT,
      );
      // 4 | 1 | 2 === 7 under spec values.
      expect(Stage.ALL).toBe(7);
    });
  });

  describe("uniformBuffer", function () {
    it("builds a uniform-buffer entry with the given binding + visibility", function () {
      const entry = uniformBuffer(3, Stage.VERTEX);
      expect(entry.binding).toBe(3);
      expect(entry.visibility).toBe(Stage.VERTEX);
      expect(entry.buffer.type).toBe("uniform");
    });

    it("leaves dynamic-offset and minBindingSize undefined by default", function () {
      const entry = uniformBuffer(0, Stage.FRAGMENT);
      expect(entry.buffer.hasDynamicOffset).toBeUndefined();
      expect(entry.buffer.minBindingSize).toBeUndefined();
    });

    it("forwards hasDynamicOffset and minBindingSize options", function () {
      const entry = uniformBuffer(1, Stage.VERTEX_FRAGMENT, {
        hasDynamicOffset: true,
        minBindingSize: 64,
      });
      expect(entry.buffer.hasDynamicOffset).toBe(true);
      expect(entry.buffer.minBindingSize).toBe(64);
    });

    it("does not emit texture/sampler/storage descriptors", function () {
      const entry = uniformBuffer(0, Stage.VERTEX);
      expect(entry.texture).toBeUndefined();
      expect(entry.sampler).toBeUndefined();
      expect(entry.storageTexture).toBeUndefined();
    });
  });

  describe("storageBuffer", function () {
    it("defaults to read-write 'storage' type", function () {
      const entry = storageBuffer(2, Stage.COMPUTE);
      expect(entry.binding).toBe(2);
      expect(entry.visibility).toBe(Stage.COMPUTE);
      expect(entry.buffer.type).toBe("storage");
    });

    it("maps readOnly: true to 'read-only-storage'", function () {
      const entry = storageBuffer(0, Stage.COMPUTE, { readOnly: true });
      expect(entry.buffer.type).toBe("read-only-storage");
    });

    it("maps readOnly: false to 'storage'", function () {
      const entry = storageBuffer(0, Stage.COMPUTE, { readOnly: false });
      expect(entry.buffer.type).toBe("storage");
    });

    it("forwards hasDynamicOffset", function () {
      const entry = storageBuffer(0, Stage.COMPUTE, { hasDynamicOffset: true });
      expect(entry.buffer.hasDynamicOffset).toBe(true);
    });
  });

  describe("texture", function () {
    it("defaults to 2D float, non-multisampled", function () {
      const entry = texture(5, Stage.FRAGMENT);
      expect(entry.binding).toBe(5);
      expect(entry.visibility).toBe(Stage.FRAGMENT);
      expect(entry.texture.sampleType).toBe("float");
      expect(entry.texture.viewDimension).toBe("2d");
      expect(entry.texture.multisampled).toBeUndefined();
    });

    it("forwards sampleType, viewDimension, and multisampled overrides", function () {
      const entry = texture(0, Stage.FRAGMENT, {
        sampleType: "depth",
        viewDimension: "cube",
        multisampled: true,
      });
      expect(entry.texture.sampleType).toBe("depth");
      expect(entry.texture.viewDimension).toBe("cube");
      expect(entry.texture.multisampled).toBe(true);
    });
  });

  describe("storageTexture", function () {
    it("defaults access to 'write-only' and viewDimension to '2d'", function () {
      const entry = storageTexture(1, Stage.COMPUTE, "rgba8unorm");
      expect(entry.binding).toBe(1);
      expect(entry.visibility).toBe(Stage.COMPUTE);
      expect(entry.storageTexture.format).toBe("rgba8unorm");
      expect(entry.storageTexture.access).toBe("write-only");
      expect(entry.storageTexture.viewDimension).toBe("2d");
    });

    it("forwards access and viewDimension overrides", function () {
      const entry = storageTexture(0, Stage.COMPUTE, "r32float", {
        access: "read-only",
        viewDimension: "3d",
      });
      expect(entry.storageTexture.access).toBe("read-only");
      expect(entry.storageTexture.viewDimension).toBe("3d");
      expect(entry.storageTexture.format).toBe("r32float");
    });
  });

  describe("sampler", function () {
    it("defaults to 'filtering' type", function () {
      const entry = sampler(7, Stage.FRAGMENT);
      expect(entry.binding).toBe(7);
      expect(entry.visibility).toBe(Stage.FRAGMENT);
      expect(entry.sampler.type).toBe("filtering");
    });

    it("honors an explicit sampler type argument", function () {
      const entry = sampler(0, Stage.FRAGMENT, "comparison");
      expect(entry.sampler.type).toBe("comparison");
    });

    it("supports the 'non-filtering' type", function () {
      const entry = sampler(0, Stage.FRAGMENT, "non-filtering");
      expect(entry.sampler.type).toBe("non-filtering");
    });
  });

  describe("makeBindGroupLayout", function () {
    // makeBindGroupLayout delegates straight to device.createBindGroupLayout,
    // which requires a live GPUDevice — that path is intentionally NOT
    // exercised here. We instead verify the helper is exported and forwards
    // its label + entries verbatim to the device, using a stub device that
    // captures the descriptor. This keeps the test device-free while still
    // pinning the call contract (label passthrough, entries array forwarded).
    it("is exported as a function", function () {
      expect(typeof makeBindGroupLayout).toBe("function");
    });

    it("forwards label and entries to device.createBindGroupLayout", function () {
      let captured;
      const sentinel = { kind: "fake-bgl" };
      const stubDevice = {
        createBindGroupLayout(descriptor) {
          captured = descriptor;
          return sentinel;
        },
      };
      const entries = [
        uniformBuffer(0, Stage.VERTEX),
        texture(1, Stage.FRAGMENT),
      ];
      const result = makeBindGroupLayout(stubDevice, "MyLayout", entries);
      expect(result).toBe(sentinel);
      expect(captured.label).toBe("MyLayout");
      expect(captured.entries).toEqual(entries);
      expect(captured.entries.length).toBe(2);
    });
  });
});
