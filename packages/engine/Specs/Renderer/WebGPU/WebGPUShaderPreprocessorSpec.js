import {
  registerShaderPreprocessor,
  getActiveShaderPreprocessor,
} from "../../../Source/Renderer/WebGPU/WebGPUShaderTranslator.js";

describe("Renderer/WebGPU/WebGPUShaderTranslator preprocessor registry", function () {
  afterEach(function () {
    // Registry is module-global — clear after each test so cross-
    // contamination between specs can't happen.
    registerShaderPreprocessor(null);
  });

  it("returns null when no preprocessor is registered", function () {
    registerShaderPreprocessor(null);
    expect(getActiveShaderPreprocessor()).toBeNull();
  });

  it("registerShaderPreprocessor stores the preprocessor", function () {
    const pp = {
      name: "test-pp",
      supports: ["glsl"],
      preprocess: (source) => `// combined\n${source}`,
    };
    registerShaderPreprocessor(pp);
    expect(getActiveShaderPreprocessor()).toBe(pp);
  });

  it("subsequent registrations replace the previous one", function () {
    const first = {
      name: "first",
      supports: ["glsl"],
      preprocess: (s) => s,
    };
    const second = {
      name: "second",
      supports: ["glsl"],
      preprocess: (s) => s,
    };
    registerShaderPreprocessor(first);
    registerShaderPreprocessor(second);
    expect(getActiveShaderPreprocessor()).toBe(second);
  });

  it("registerShaderPreprocessor(null) clears the registry", function () {
    registerShaderPreprocessor({
      name: "temp",
      supports: ["glsl"],
      preprocess: (s) => s,
    });
    registerShaderPreprocessor(null);
    expect(getActiveShaderPreprocessor()).toBeNull();
  });

  it("preprocessors can report the languages they support", function () {
    const glslOnly = {
      name: "glsl-only",
      supports: ["glsl"],
      preprocess: (s) => s,
    };
    registerShaderPreprocessor(glslOnly);
    const active = getActiveShaderPreprocessor();
    expect(active.supports).toContain("glsl");
    expect(active.supports).not.toContain("wgsl");
  });
});
