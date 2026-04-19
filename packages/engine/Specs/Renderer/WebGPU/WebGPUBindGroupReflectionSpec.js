import {
  parseNagaReflection,
  buildBindGroupLayoutDescriptors,
} from "../../../Source/Renderer/WebGPU/WebGPUBindGroupReflection.js";

// These specs are pure-function tests — no GPU device needed. They
// verify the reflection-JSON → BGL-descriptor contract using the
// shape that `validate_wgsl` would emit for typical shader inputs.

// GPUShaderStage global isn't declared in Node; provide constants
// that match the WebGPU spec values so the visibility defaults in
// `buildBindGroupLayoutDescriptors` resolve correctly.
if (typeof globalThis.GPUShaderStage === "undefined") {
  globalThis.GPUShaderStage = {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
  };
}

describe("Renderer/WebGPU/WebGPUBindGroupReflection", function () {
  describe("parseNagaReflection", function () {
    it("parses a well-formed JSON blob", function () {
      const json = JSON.stringify({
        entryPoints: [{ name: "main", stage: "fragment" }],
        bindings: [],
      });
      const r = parseNagaReflection(json);
      expect(r.entryPoints.length).toBe(1);
      expect(r.bindings).toEqual([]);
    });

    it("throws a helpful error on malformed JSON", function () {
      expect(() => parseNagaReflection("not json")).toThrowError(
        /not valid JSON/,
      );
    });

    it("throws when top-level fields are missing", function () {
      expect(() => parseNagaReflection('{"bindings":[]}')).toThrowError(
        /missing top-level/,
      );
    });
  });

  describe("buildBindGroupLayoutDescriptors", function () {
    it("emits one descriptor per declared group", function () {
      const reflection = {
        entryPoints: [{ name: "main", stage: "fragment" }],
        bindings: [
          { name: "a", group: 0, binding: 0, kind: "uniform-buffer" },
          {
            name: "b",
            group: 0,
            binding: 1,
            kind: "sampler",
            sampleType: "filtering",
          },
          { name: "c", group: 2, binding: 0, kind: "uniform-buffer" },
        ],
      };
      const layouts = buildBindGroupLayoutDescriptors(reflection);
      expect(layouts.size).toBe(2);
      expect(layouts.has(0)).toBe(true);
      expect(layouts.has(2)).toBe(true);
      // Sparse — group 1 is not represented.
      expect(layouts.has(1)).toBe(false);
    });

    it("sorts entries by binding index within a group", function () {
      const reflection = {
        entryPoints: [],
        bindings: [
          { name: "c", group: 0, binding: 2, kind: "uniform-buffer" },
          { name: "a", group: 0, binding: 0, kind: "uniform-buffer" },
          { name: "b", group: 0, binding: 1, kind: "uniform-buffer" },
        ],
      };
      const layouts = buildBindGroupLayoutDescriptors(reflection);
      const entries = layouts.get(0).entries;
      expect(entries.map((e) => e.binding)).toEqual([0, 1, 2]);
    });

    it("translates uniform buffer with minBindingSize", function () {
      const reflection = {
        entryPoints: [],
        bindings: [
          {
            name: "u",
            group: 0,
            binding: 0,
            kind: "uniform-buffer",
            minBindingSize: 32,
          },
        ],
      };
      const entry =
        buildBindGroupLayoutDescriptors(reflection).get(0).entries[0];
      expect(entry.buffer.type).toBe("uniform");
      expect(entry.buffer.minBindingSize).toBe(32);
    });

    it("translates storage buffer access modes", function () {
      const reflection = {
        entryPoints: [],
        bindings: [
          {
            name: "ro",
            group: 0,
            binding: 0,
            kind: "storage-buffer",
            access: "read",
          },
          {
            name: "rw",
            group: 0,
            binding: 1,
            kind: "storage-buffer",
            access: "read_write",
          },
        ],
      };
      const entries =
        buildBindGroupLayoutDescriptors(reflection).get(0).entries;
      expect(entries[0].buffer.type).toBe("read-only-storage");
      expect(entries[1].buffer.type).toBe("storage");
    });

    it("translates texture bindings with sample type + view dimension", function () {
      const reflection = {
        entryPoints: [],
        bindings: [
          {
            name: "tex",
            group: 0,
            binding: 0,
            kind: "texture",
            sampleType: "float",
            viewDimension: "2d",
            multisampled: false,
          },
          {
            name: "cube",
            group: 0,
            binding: 1,
            kind: "texture",
            sampleType: "depth",
            viewDimension: "cube",
            multisampled: false,
          },
        ],
      };
      const entries =
        buildBindGroupLayoutDescriptors(reflection).get(0).entries;
      expect(entries[0].texture.sampleType).toBe("float");
      expect(entries[0].texture.viewDimension).toBe("2d");
      expect(entries[1].texture.sampleType).toBe("depth");
      expect(entries[1].texture.viewDimension).toBe("cube");
    });

    it("translates sampler types", function () {
      const reflection = {
        entryPoints: [],
        bindings: [
          {
            name: "s",
            group: 0,
            binding: 0,
            kind: "sampler",
            sampleType: "filtering",
          },
          {
            name: "c",
            group: 0,
            binding: 1,
            kind: "sampler",
            sampleType: "comparison",
          },
        ],
      };
      const entries =
        buildBindGroupLayoutDescriptors(reflection).get(0).entries;
      expect(entries[0].sampler.type).toBe("filtering");
      expect(entries[1].sampler.type).toBe("comparison");
    });

    it("translates storage textures with write access", function () {
      const reflection = {
        entryPoints: [],
        bindings: [
          {
            name: "st",
            group: 0,
            binding: 0,
            kind: "storage-texture",
            access: "write",
            viewDimension: "2d",
          },
        ],
      };
      const entry =
        buildBindGroupLayoutDescriptors(reflection).get(0).entries[0];
      expect(entry.storageTexture.access).toBe("write-only");
      expect(entry.storageTexture.viewDimension).toBe("2d");
    });

    it("skips bindings with 'unknown' kind", function () {
      const reflection = {
        entryPoints: [],
        bindings: [
          { name: "a", group: 0, binding: 0, kind: "uniform-buffer" },
          { name: "mystery", group: 0, binding: 1, kind: "unknown" },
        ],
      };
      const entries =
        buildBindGroupLayoutDescriptors(reflection).get(0).entries;
      expect(entries.length).toBe(1);
      expect(entries[0].binding).toBe(0);
    });

    it("respects custom visibility flags", function () {
      const reflection = {
        entryPoints: [],
        bindings: [{ name: "u", group: 0, binding: 0, kind: "uniform-buffer" }],
      };
      const layouts = buildBindGroupLayoutDescriptors(reflection, {
        visibility: GPUShaderStage.FRAGMENT,
      });
      expect(layouts.get(0).entries[0].visibility).toBe(
        GPUShaderStage.FRAGMENT,
      );
    });

    it("applies label prefix", function () {
      const reflection = {
        entryPoints: [],
        bindings: [{ name: "u", group: 0, binding: 0, kind: "uniform-buffer" }],
      };
      const layouts = buildBindGroupLayoutDescriptors(reflection, {
        labelPrefix: "TestShader",
      });
      expect(layouts.get(0).label).toBe("TestShader group 0");
    });
  });
});
