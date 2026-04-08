import {
  transpileGLSL,
  isNagaReady,
  isNagaUnavailable,
  _resetNagaTranspilerForTests,
} from "../../../Source/Renderer/WebGPU/WebGPUNagaTranspiler.js";

describe("Renderer/WebGPU/WebGPUNagaTranspiler", function () {
  beforeEach(function () {
    _resetNagaTranspilerForTests();
  });

  // Smallest GLSL shader that round-trips through Naga's `glsl_in` parser.
  // Spec uses #version 450 because that's the dialect Naga's GLSL frontend
  // accepts unconditionally — earlier `#version 330` requires the user to
  // turn on the desktop GL feature in Naga's options.
  const SAMPLE_VS = `#version 450
layout(location = 0) in vec3 aPos;
void main() {
  gl_Position = vec4(aPos, 1.0);
}`;

  it("returns a result object on the first call (cached=false)", async function () {
    const result = await transpileGLSL(SAMPLE_VS, "vertex");
    expect(result).toBeDefined();
    expect(result.cached).toBe(false);
    // wgsl is null when naga-wasm isn't installed; that's the documented
    // fallback path. Either outcome is valid for the spike — we're
    // primarily verifying the loader handles "package missing" cleanly.
    expect(result.wgsl === null || typeof result.wgsl === "string").toBe(true);
  });

  it("caches the result so a second call returns cached=true", async function () {
    const first = await transpileGLSL(SAMPLE_VS, "vertex");
    const second = await transpileGLSL(SAMPLE_VS, "vertex");
    expect(first.wgsl).toBe(second.wgsl);
    expect(second.cached).toBe(true);
  });

  it("differentiates the cache by stage", async function () {
    const vs = await transpileGLSL(SAMPLE_VS, "vertex");
    const fs = await transpileGLSL(SAMPLE_VS, "fragment");
    // Cache key includes the stage prefix, so the second call must miss
    // the cache the first time it sees a new stage even with identical
    // source bytes.
    expect(fs.cached).toBe(false);
    // Both calls should produce the same shape of result though.
    expect(typeof vs.cached).toBe("boolean");
  });

  it("never throws on unavailable naga-wasm; reports via isNagaUnavailable", async function () {
    await transpileGLSL(SAMPLE_VS, "vertex");
    // After the first call settles, exactly one of these is true:
    //   - naga-wasm was installed and isNagaReady() returns true
    //   - naga-wasm wasn't installed and isNagaUnavailable() returns true
    // Both states are valid; what matters is that the loader didn't
    // throw and didn't leave both flags false (which would mean the
    // promise never resolved).
    expect(isNagaReady() || isNagaUnavailable()).toBe(true);
  });

  it("returns wgsl: null with an error string when transpile fails", async function () {
    const result = await transpileGLSL("not glsl at all {{{", "vertex");
    if (result.wgsl === null) {
      // Either the package is missing (error: "naga-wasm not installed")
      // or the parser rejected the source (error: parser diagnostic).
      // Both are acceptable failure modes for the spike.
      expect(typeof result.error).toBe("string");
    }
  });
});
