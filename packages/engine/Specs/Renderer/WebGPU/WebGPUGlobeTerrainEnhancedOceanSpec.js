import { preprocess } from "../../../Source/Renderer/WebGPU/WebGPUShaderPreprocessor.js";
import {
  ShaderDefine,
  ShaderDefineHi,
} from "../../../Source/Renderer/WebGPU/WebGPUShaderDefines.js";
import GlobeTerrainSource from "../../../Source/Shaders/WebGPU/Globe/GlobeTerrain.js";

// C11-158 / NEW-WEBGPU-ENHANCED-OCEAN-DEFAULT-PARITY-TOGGLE.
//
// Extends the C11-149 preprocessor-spec pattern (WebGPUShaderPreprocessorIfdefSpec)
// with a smoke test over the REAL `GlobeTerrain.wgsl` source (imported as the
// build-generated JS string module, the same way the renderer consumes it).
//
// The toggle gates ONLY the ocean STYLING inside `computeEnhancedOcean` behind
// the FIRST production hi-word define, `ShaderDefineHi.ENHANCED_OCEAN`:
//   - hi word clear (the DEFAULT)     -> `//>>else` classic WebGL-parity branch
//   - hi word = ENHANCED_OCEAN        -> `//>>ifdef` enhanced (foam etc.) branch
// The shared wave march (`sampleOceanWaveNormals` -> perturbed `waterNormal`)
// sits ABOVE the gate and must appear in BOTH branches.
//
// ON BYTE-PARITY OF THE ENHANCED BRANCH (honest note): the task asks to pin the
// hi=ENHANCED_OCEAN output byte-for-byte against a PRE-CHANGE oracle IF feasible.
// A committed pre-change GlobeTerrain fixture does not exist and re-deriving one
// in-spec would just re-implement the preprocessor, so this spec instead asserts
// SEMANTIC + STRUCTURAL markers: the enhanced styling code was MOVED verbatim
// (directive-wrapped, not rewritten), so — because the preprocessor only strips
// the consumed `//>>` directive lines and drops the `//>>else` body — the
// hi=ENHANCED_OCEAN output equals the pre-toggle source minus those directive
// lines. The verbatim-tail assertion below (`color = mix(color, foamColor,
// foamFactor);`) is the load-bearing "moved, not rewritten" check.
describe("Renderer/WebGPU/GlobeTerrain enhanced-ocean styling gate (C11-158)", function () {
  // The lo word is orthogonal to the ocean gate; sweep a couple of masks to
  // prove the hi gate resolves independently of any lo-word variant.
  const LO_MASKS = [0, ShaderDefine.LOG_DEPTH, ShaderDefine.GEODETIC_NORMAL];

  function classicOf(defines) {
    return preprocess(GlobeTerrainSource, defines, 0);
  }
  function enhancedOf(defines) {
    return preprocess(
      GlobeTerrainSource,
      defines,
      ShaderDefineHi.ENHANCED_OCEAN,
    );
  }

  it("the imported source actually carries the ENHANCED_OCEAN directives", function () {
    // Guards against a build that stripped `//>>` comment directives (which
    // would silently break the runtime preprocessor, not just this spec).
    expect(GlobeTerrainSource.length).toBeGreaterThan(0);
    expect(GlobeTerrainSource).toContain("//>>ifdef ENHANCED_OCEAN");
    expect(GlobeTerrainSource).toContain("//>>else");
    expect(GlobeTerrainSource).toContain("//>>endif");
    expect(GlobeTerrainSource).toContain("fn computeEnhancedOcean");
  });

  it("emits distinct, valid, non-empty sources for hi=0 vs hi=ENHANCED_OCEAN", function () {
    for (const defines of LO_MASKS) {
      const classic = classicOf(defines);
      const enhanced = enhancedOf(defines);
      expect(classic.length).toBeGreaterThan(0);
      expect(enhanced.length).toBeGreaterThan(0);
      // The two ocean-styling variants must differ.
      expect(classic).not.toBe(enhanced);
      // Both are fully resolved — no unresolved directive LINE survives
      // preprocessing. (Checked line-anchored, not by substring: GlobeTerrain
      // has prose comments that legitimately quote `//>>ifdef ...` mid-line —
      // e.g. the conventions ledger — which the anchored `^\s*//>>` preprocessor
      // correctly leaves as ordinary comment text.)
      const directiveLine = /^\s*\/\/>>\s*(?:ifdef|else|endif)\b/;
      for (const out of [classic, enhanced]) {
        const residual = out.split("\n").some((l) => directiveLine.test(l));
        expect(residual).toBe(false);
      }
    }
  });

  it("keeps the shared wave march unconditional (styling-only gate)", function () {
    for (const defines of LO_MASKS) {
      const classic = classicOf(defines);
      const enhanced = enhancedOf(defines);
      // The function itself and the wave-normal march call live ABOVE the gate,
      // so BOTH branches contain them — the toggle never touches the waves.
      for (const out of [classic, enhanced]) {
        expect(out).toContain("fn computeEnhancedOcean");
        // C11-172 v3: the shared march samples in an RTE-decomposed physical-
        // wavelength ellipsoid UV; the call passes the tile-local UV + its
        // derivatives + the three packed phase offsets + the clock.
        expect(out).toContain("sampleOceanWaveNormals(");
        expect(out).toContain("euvLocal, euvDx, euvDy,");
        // The shared perturbed eye-space normal feeds both branches.
        expect(out).toContain("waveNormalEC");
      }
    }
  });

  it("hi=0 (default) emits the classic WebGL-parity branch, NOT the enhanced styling", function () {
    for (const defines of LO_MASKS) {
      const classic = classicOf(defines);
      // Classic-only markers (the `//>>else` faithful computeWaterColor port).
      expect(classic).toContain("Classic WebGL-parity ocean styling");
      expect(classic).toContain("classicSurfaceReflectance");
      expect(classic).toContain("classicDiffuseHighlight");
      // Enhanced-only markers must be absent from the default output.
      expect(classic).not.toContain("oceanContribution");
      expect(classic).not.toContain("let foamColor");
    }
  });

  it("hi=ENHANCED_OCEAN emits the enhanced styling, NOT the classic branch", function () {
    for (const defines of LO_MASKS) {
      const enhanced = enhancedOf(defines);
      // Enhanced-only markers (the `//>>ifdef` WebGPU-only look).
      expect(enhanced).toContain("oceanContribution");
      expect(enhanced).toContain("let foamColor");
      // The verbatim MOVED tail — proves the enhanced code was relocated into
      // the ifdef block, not rewritten (the load-bearing byte-honesty check).
      expect(enhanced).toContain("color = mix(color, foamColor, foamFactor);");
      // Classic-only markers must be absent from the enhanced output.
      expect(enhanced).not.toContain("classicSurfaceReflectance");
      expect(enhanced).not.toContain("Classic WebGL-parity ocean styling");
    }
  });
});
