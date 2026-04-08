import {
  WGSLShaderPreprocessor,
  WGSLShaderLibrary,
} from "../../../Source/Renderer/WebGPU/WGSLShaderPreprocessor.js";
import { createDefaultWGSLLibrary } from "../../../Source/Renderer/WebGPU/WGSLBuiltins.js";

describe("Renderer/WebGPU/WGSLShaderPreprocessor", function () {
  // The WGSL preprocessor is the engine's compile-time module system —
  // it resolves `#import "..."` directives, auto-resolves `csm_` prefix
  // references against the shader library, and topologically sorts
  // dependencies before splicing them into the final WGSL source.
  //
  // The wgsl-import-test.html browser page (FORK-16) covers the same
  // surface end-to-end against a live GPU device. This Karma spec
  // duplicates the static-analysis half (parse, library, dependency
  // resolution) so the CI run catches preprocessor regressions without
  // needing a working WebGPU device.

  describe("WGSLShaderLibrary", function () {
    it("registers a chunk by name", function () {
      const lib = new WGSLShaderLibrary();
      lib.registerCode("structs/Foo", "struct Foo { x: f32, }");
      expect(lib.has("structs/Foo")).toBe(true);
      expect(lib.size).toBe(1);
    });

    it("returns undefined for unregistered chunks", function () {
      const lib = new WGSLShaderLibrary();
      expect(lib.has("structs/Bar")).toBe(false);
      expect(lib.get("structs/Bar")).toBeUndefined();
    });

    it("indexes csm_ function identifiers for auto-resolution", function () {
      const lib = new WGSLShaderLibrary();
      lib.registerCode(
        "functions/csm_demo",
        "fn csm_demoFn(x: f32) -> f32 { return x * 2.0; }",
      );
      // The auto-resolution index lets a shader that calls csm_demoFn
      // pull in the chunk without an explicit `#import`.
      expect(lib.getChunkForIdentifier("csm_demoFn")).toBe(
        "functions/csm_demo",
      );
    });

    it("indexes struct identifiers for auto-resolution", function () {
      const lib = new WGSLShaderLibrary();
      lib.registerCode(
        "structs/CameraUniforms",
        "struct CameraUniforms { mvp: mat4x4<f32>, }",
      );
      expect(lib.getChunkForIdentifier("CameraUniforms")).toBe(
        "structs/CameraUniforms",
      );
    });
  });

  describe("WGSLShaderPreprocessor.parseImports", function () {
    it("parses a single explicit #import", function () {
      const src = `// #import "functions/csm_phong"\n@vertex fn main() {}`;
      expect(WGSLShaderPreprocessor.parseImports(src)).toEqual([
        "functions/csm_phong",
      ]);
    });

    it("parses multiple explicit #imports", function () {
      const src = `
// #import "structs/CameraUniforms"
// #import "functions/csm_phong"
// #import "functions/csm_constants"
@vertex fn main() {}`;
      const imports = WGSLShaderPreprocessor.parseImports(src);
      expect(imports.length).toBe(3);
      expect(imports).toContain("structs/CameraUniforms");
      expect(imports).toContain("functions/csm_phong");
      expect(imports).toContain("functions/csm_constants");
    });

    it("deduplicates repeated #imports of the same chunk", function () {
      const src = `
// #import "functions/csm_phong"
// #import "functions/csm_phong"
@vertex fn main() {}`;
      expect(WGSLShaderPreprocessor.parseImports(src)).toEqual([
        "functions/csm_phong",
      ]);
    });

    it("returns an empty list when no imports are present", function () {
      expect(
        WGSLShaderPreprocessor.parseImports("@vertex fn main() {}"),
      ).toEqual([]);
    });
  });

  describe("WGSLShaderPreprocessor.removeComments", function () {
    it("strips line comments", function () {
      const src = "let x = 1; // trailing comment\nlet y = 2;";
      const out = WGSLShaderPreprocessor.removeComments(src);
      expect(out).not.toContain("trailing comment");
      expect(out).toContain("let x = 1;");
      expect(out).toContain("let y = 2;");
    });

    it("strips block comments", function () {
      const src = "let x = 1; /* block */ let y = 2;";
      const out = WGSLShaderPreprocessor.removeComments(src);
      expect(out).not.toContain("block");
      expect(out).toContain("let x = 1;");
      expect(out).toContain("let y = 2;");
    });

    it("preserves line count when stripping multi-line block comments", function () {
      // Comment-removal must not collapse line numbers because diagnostic
      // messages from the WebGPU shader compiler reference source line
      // numbers — collapsing would shift every error report.
      const src = "let a = 1;\n/* line2\nline3\nline4 */\nlet b = 2;";
      const before = src.split("\n").length;
      const out = WGSLShaderPreprocessor.removeComments(src);
      const after = out.split("\n").length;
      expect(after).toBe(before);
    });
  });

  describe("WGSLShaderPreprocessor.process (with default library)", function () {
    let pp;
    beforeAll(function () {
      const lib = createDefaultWGSLLibrary();
      pp = new WGSLShaderPreprocessor(lib);
    });

    it("resolves an explicit import from the production library", function () {
      const src = `// #import "structs/CameraUniforms"\n@vertex fn main() {}`;
      const result = pp.process(src);
      expect(result.includedChunks).toContain("structs/CameraUniforms");
      expect(result.code).toContain("struct CameraUniforms");
    });

    it("auto-resolves a csm_ reference without an explicit #import", function () {
      const src = `
@fragment fn fragmentMain() -> @location(0) vec4<f32> {
  let toned = csm_reinhardTonemap(vec3<f32>(1.0));
  return vec4<f32>(toned, 1.0);
}`;
      const result = pp.process(src);
      expect(result.includedChunks).toContain("functions/csm_tonemapping");
      expect(result.code).toContain("fn csm_reinhardTonemap");
    });

    it("pulls in transitive dependencies via the dependency graph", function () {
      // csm_distributionGGX depends on csm_constants (CSM_PI). The
      // preprocessor must resolve the transitive dep automatically.
      const src = `
// #import "functions/csm_distributionGGX"
@fragment fn main() -> @location(0) vec4<f32> { return vec4(1.0); }`;
      const result = pp.process(src);
      expect(result.includedChunks).toContain("functions/csm_constants");
      expect(result.code).toContain("CSM_PI");
    });

    it("emits each chunk only once even when imported transitively", function () {
      const src = `
// #import "functions/csm_constants"
// #import "functions/csm_distributionGGX"
@fragment fn main() -> @location(0) vec4<f32> { return vec4(1.0); }`;
      const result = pp.process(src);
      const piCount = (result.code.match(/const CSM_PI/g) || []).length;
      expect(piCount).toBe(1);
    });

    it("respects #ifdef branches when defines are passed", function () {
      const src = `
// #ifdef USE_PHONG
fn lighting() -> vec3<f32> { return vec3<f32>(1.0, 0.0, 0.0); }
// #else
fn lighting() -> vec3<f32> { return vec3<f32>(0.0, 1.0, 0.0); }
// #endif
`;
      const withPhong = pp.process(src, { defines: ["USE_PHONG"] });
      expect(withPhong.code).toContain("1.0, 0.0, 0.0");
      expect(withPhong.code).not.toContain("0.0, 1.0, 0.0");

      const withoutPhong = pp.process(src, { defines: [] });
      expect(withoutPhong.code).toContain("0.0, 1.0, 0.0");
      expect(withoutPhong.code).not.toContain("1.0, 0.0, 0.0");
    });
  });
});
