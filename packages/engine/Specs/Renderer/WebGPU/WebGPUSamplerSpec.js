import WebGPUSampler from "../../../Source/Renderer/WebGPU/WebGPUSampler.js";

// ── Coverage notes ──────────────────────────────────────────────────
//
// WebGPUSampler converts CesiumJS WebGL texture enums (TextureWrap,
// TextureMinificationFilter, TextureMagnificationFilter) into a
// GPUSamplerDescriptor and computes a deterministic cache key from it.
// Everything below is pure — the constructor never touches a GPUDevice;
// it only builds the descriptor + cache key. Static factories
// (createNearest / createLinearMipmap / createRepeatLinear /
// createDepthComparisonSampler / fromCesiumSampler) and the static
// helpers (computeCacheKey / equals) are likewise device-free.
//
// SKIPPED (device-bound — need a real GPUDevice/context):
//   - getOrCreate(device)        → device.createSampler(...)
//   - getOrCreateCached(context) → context.getOrCreateSampler / device
//
// CesiumJS WebGL enum constants, copied verbatim from WebGPUSampler.ts:
const GL_CLAMP_TO_EDGE = 0x812f;
const GL_REPEAT = 0x2901;
const GL_MIRRORED_REPEAT = 0x8370;
const GL_NEAREST = 0x2600;
const GL_LINEAR = 0x2601;
const GL_NEAREST_MIPMAP_NEAREST = 0x2700;
const GL_LINEAR_MIPMAP_NEAREST = 0x2701;
const GL_NEAREST_MIPMAP_LINEAR = 0x2702;
const GL_LINEAR_MIPMAP_LINEAR = 0x2703;

describe("Renderer/WebGPU/WebGPUSampler", function () {
  it("is defined", function () {
    expect(WebGPUSampler).toBeDefined();
  });

  describe("constructor defaults (empty options)", function () {
    // Defaults from the constructor: wrapS/T/R = CLAMP_TO_EDGE,
    // minFilter = LINEAR, magFilter = LINEAR, maxAnisotropy = 1.0.
    it("defaults all address modes to 'clamp-to-edge'", function () {
      const d = new WebGPUSampler().descriptor;
      expect(d.addressModeU).toBe("clamp-to-edge");
      expect(d.addressModeV).toBe("clamp-to-edge");
      expect(d.addressModeW).toBe("clamp-to-edge");
    });

    it("defaults min/mag/mipmap filters from GL_LINEAR", function () {
      // GL_LINEAR min → { minFilter: 'linear', mipmapFilter: 'nearest' }.
      // GL_LINEAR mag → 'linear'.
      const d = new WebGPUSampler().descriptor;
      expect(d.minFilter).toBe("linear");
      expect(d.magFilter).toBe("linear");
      expect(d.mipmapFilter).toBe("nearest");
    });

    it("defaults maxAnisotropy to 1", function () {
      expect(new WebGPUSampler().descriptor.maxAnisotropy).toBe(1);
    });

    it("omits compare when no compareFunction is given", function () {
      expect(new WebGPUSampler().descriptor.compare).toBeUndefined();
    });

    it("omits label when none is given", function () {
      expect(new WebGPUSampler().descriptor.label).toBeUndefined();
    });

    it("reports usesMipmaps false for the default (non-mipmap) min filter", function () {
      expect(new WebGPUSampler().usesMipmaps).toBe(false);
    });
  });

  describe("address-mode mapping (toAddressMode)", function () {
    it("maps GL_REPEAT → 'repeat'", function () {
      const d = new WebGPUSampler({ wrapS: GL_REPEAT }).descriptor;
      expect(d.addressModeU).toBe("repeat");
    });

    it("maps GL_MIRRORED_REPEAT → 'mirror-repeat'", function () {
      const d = new WebGPUSampler({ wrapT: GL_MIRRORED_REPEAT }).descriptor;
      expect(d.addressModeV).toBe("mirror-repeat");
    });

    it("maps GL_CLAMP_TO_EDGE → 'clamp-to-edge'", function () {
      const d = new WebGPUSampler({ wrapR: GL_CLAMP_TO_EDGE }).descriptor;
      expect(d.addressModeW).toBe("clamp-to-edge");
    });

    it("defaults an unknown wrap enum to 'clamp-to-edge'", function () {
      // 0xDEAD is not a real TextureWrap enum → default branch.
      const d = new WebGPUSampler({ wrapS: 0xdead }).descriptor;
      expect(d.addressModeU).toBe("clamp-to-edge");
    });

    it("maps each axis independently", function () {
      const d = new WebGPUSampler({
        wrapS: GL_REPEAT,
        wrapT: GL_MIRRORED_REPEAT,
        wrapR: GL_CLAMP_TO_EDGE,
      }).descriptor;
      expect(d.addressModeU).toBe("repeat");
      expect(d.addressModeV).toBe("mirror-repeat");
      expect(d.addressModeW).toBe("clamp-to-edge");
    });
  });

  describe("minification-filter mapping (toMinFilter)", function () {
    // Each case copied verbatim from toMinFilter's switch.
    it("GL_NEAREST → min 'nearest', mipmap 'nearest'", function () {
      const d = new WebGPUSampler({ minificationFilter: GL_NEAREST })
        .descriptor;
      expect(d.minFilter).toBe("nearest");
      expect(d.mipmapFilter).toBe("nearest");
    });

    it("GL_LINEAR → min 'linear', mipmap 'nearest'", function () {
      const d = new WebGPUSampler({ minificationFilter: GL_LINEAR }).descriptor;
      expect(d.minFilter).toBe("linear");
      expect(d.mipmapFilter).toBe("nearest");
    });

    it("GL_NEAREST_MIPMAP_NEAREST → min 'nearest', mipmap 'nearest'", function () {
      const d = new WebGPUSampler({
        minificationFilter: GL_NEAREST_MIPMAP_NEAREST,
      }).descriptor;
      expect(d.minFilter).toBe("nearest");
      expect(d.mipmapFilter).toBe("nearest");
    });

    it("GL_LINEAR_MIPMAP_NEAREST → min 'linear', mipmap 'nearest'", function () {
      const d = new WebGPUSampler({
        minificationFilter: GL_LINEAR_MIPMAP_NEAREST,
      }).descriptor;
      expect(d.minFilter).toBe("linear");
      expect(d.mipmapFilter).toBe("nearest");
    });

    it("GL_NEAREST_MIPMAP_LINEAR → min 'nearest', mipmap 'linear'", function () {
      const d = new WebGPUSampler({
        minificationFilter: GL_NEAREST_MIPMAP_LINEAR,
      }).descriptor;
      expect(d.minFilter).toBe("nearest");
      expect(d.mipmapFilter).toBe("linear");
    });

    it("GL_LINEAR_MIPMAP_LINEAR → min 'linear', mipmap 'linear'", function () {
      const d = new WebGPUSampler({
        minificationFilter: GL_LINEAR_MIPMAP_LINEAR,
      }).descriptor;
      expect(d.minFilter).toBe("linear");
      expect(d.mipmapFilter).toBe("linear");
    });

    it("defaults an unknown min filter to min 'linear', mipmap 'linear'", function () {
      const d = new WebGPUSampler({ minificationFilter: 0xdead }).descriptor;
      expect(d.minFilter).toBe("linear");
      expect(d.mipmapFilter).toBe("linear");
    });
  });

  describe("magnification-filter mapping (toMagFilter)", function () {
    it("GL_NEAREST → 'nearest'", function () {
      const d = new WebGPUSampler({ magnificationFilter: GL_NEAREST })
        .descriptor;
      expect(d.magFilter).toBe("nearest");
    });

    it("GL_LINEAR → 'linear'", function () {
      const d = new WebGPUSampler({ magnificationFilter: GL_LINEAR })
        .descriptor;
      expect(d.magFilter).toBe("linear");
    });

    it("defaults an unknown mag filter to 'linear'", function () {
      const d = new WebGPUSampler({ magnificationFilter: 0xdead }).descriptor;
      expect(d.magFilter).toBe("linear");
    });
  });

  describe("usesMipmaps accounting", function () {
    // usesMipmaps() is true only for the four *_MIPMAP_* min filters.
    it("is false for GL_NEAREST", function () {
      expect(
        new WebGPUSampler({ minificationFilter: GL_NEAREST }).usesMipmaps,
      ).toBe(false);
    });

    it("is false for GL_LINEAR", function () {
      expect(
        new WebGPUSampler({ minificationFilter: GL_LINEAR }).usesMipmaps,
      ).toBe(false);
    });

    it("is true for GL_NEAREST_MIPMAP_NEAREST", function () {
      expect(
        new WebGPUSampler({ minificationFilter: GL_NEAREST_MIPMAP_NEAREST })
          .usesMipmaps,
      ).toBe(true);
    });

    it("is true for GL_LINEAR_MIPMAP_NEAREST", function () {
      expect(
        new WebGPUSampler({ minificationFilter: GL_LINEAR_MIPMAP_NEAREST })
          .usesMipmaps,
      ).toBe(true);
    });

    it("is true for GL_NEAREST_MIPMAP_LINEAR", function () {
      expect(
        new WebGPUSampler({ minificationFilter: GL_NEAREST_MIPMAP_LINEAR })
          .usesMipmaps,
      ).toBe(true);
    });

    it("is true for GL_LINEAR_MIPMAP_LINEAR", function () {
      expect(
        new WebGPUSampler({ minificationFilter: GL_LINEAR_MIPMAP_LINEAR })
          .usesMipmaps,
      ).toBe(true);
    });
  });

  describe("maxAnisotropy math (Math.max(1, Math.floor(...)))", function () {
    it("floors a fractional anisotropy", function () {
      expect(
        new WebGPUSampler({ maximumAnisotropy: 3.9 }).descriptor.maxAnisotropy,
      ).toBe(3);
    });

    it("clamps values below 1 up to 1", function () {
      expect(
        new WebGPUSampler({ maximumAnisotropy: 0.5 }).descriptor.maxAnisotropy,
      ).toBe(1);
    });

    it("clamps zero up to 1", function () {
      expect(
        new WebGPUSampler({ maximumAnisotropy: 0 }).descriptor.maxAnisotropy,
      ).toBe(1);
    });

    it("passes an integer through unchanged", function () {
      expect(
        new WebGPUSampler({ maximumAnisotropy: 16 }).descriptor.maxAnisotropy,
      ).toBe(16);
    });
  });

  describe("optional compare + label", function () {
    it("sets compare when compareFunction is provided", function () {
      const d = new WebGPUSampler({ compareFunction: "less" }).descriptor;
      expect(d.compare).toBe("less");
    });

    it("sets label when provided", function () {
      const d = new WebGPUSampler({ label: "MySampler" }).descriptor;
      expect(d.label).toBe("MySampler");
    });
  });

  describe("computeCacheKey + cacheKey getter", function () {
    // Key format copied verbatim from computeCacheKey:
    //   `${U}:${V}:${W}:${min}:${mag}:${mipmap}:${maxAniso}:${compare ?? "none"}`
    it("produces the documented colon-joined key for the default sampler", function () {
      // Defaults → clamp/clamp/clamp : linear min : linear mag :
      // nearest mipmap : 1 aniso : no compare ('none').
      expect(new WebGPUSampler().cacheKey).toBe(
        "clamp-to-edge:clamp-to-edge:clamp-to-edge:linear:linear:nearest:1:none",
      );
    });

    it("reflects wrap + filter + anisotropy choices in the key", function () {
      const s = new WebGPUSampler({
        wrapS: GL_REPEAT,
        wrapT: GL_MIRRORED_REPEAT,
        minificationFilter: GL_LINEAR_MIPMAP_LINEAR,
        magnificationFilter: GL_NEAREST,
        maximumAnisotropy: 4,
      });
      expect(s.cacheKey).toBe(
        "repeat:mirror-repeat:clamp-to-edge:linear:nearest:linear:4:none",
      );
    });

    it("includes the compare function in the key when present", function () {
      const s = new WebGPUSampler({ compareFunction: "less-equal" });
      expect(s.cacheKey).toBe(
        "clamp-to-edge:clamp-to-edge:clamp-to-edge:linear:linear:nearest:1:less-equal",
      );
    });

    it("computeCacheKey matches the instance cacheKey for the same descriptor", function () {
      const s = new WebGPUSampler({
        wrapS: GL_REPEAT,
        minificationFilter: GL_NEAREST,
      });
      expect(WebGPUSampler.computeCacheKey(s.descriptor)).toBe(s.cacheKey);
    });

    it("computeCacheKey falls back to documented defaults for an empty descriptor", function () {
      // Each ?? default in computeCacheKey: clamp-to-edge x3, nearest min,
      // nearest mag, nearest mipmap, 1 aniso, 'none' compare.
      expect(WebGPUSampler.computeCacheKey({})).toBe(
        "clamp-to-edge:clamp-to-edge:clamp-to-edge:nearest:nearest:nearest:1:none",
      );
    });
  });

  describe("static equals", function () {
    it("returns true for the same instance (reference identity)", function () {
      const s = new WebGPUSampler();
      expect(WebGPUSampler.equals(s, s)).toBe(true);
    });

    it("returns true for two samplers with identical configuration", function () {
      const a = new WebGPUSampler({ wrapS: GL_REPEAT });
      const b = new WebGPUSampler({ wrapS: GL_REPEAT });
      expect(WebGPUSampler.equals(a, b)).toBe(true);
    });

    it("returns false for samplers with different configuration", function () {
      const a = new WebGPUSampler({ wrapS: GL_REPEAT });
      const b = new WebGPUSampler({ wrapS: GL_CLAMP_TO_EDGE });
      expect(WebGPUSampler.equals(a, b)).toBe(false);
    });

    it("returns false when the left operand is undefined", function () {
      expect(WebGPUSampler.equals(undefined, new WebGPUSampler())).toBe(false);
    });

    it("returns false when the right operand is undefined", function () {
      expect(WebGPUSampler.equals(new WebGPUSampler(), undefined)).toBe(false);
    });

    it("returns true when both operands are undefined (reference identity)", function () {
      expect(WebGPUSampler.equals(undefined, undefined)).toBe(true);
    });
  });

  describe("static factory: createNearest", function () {
    it("builds a nearest/nearest sampler with no mipmaps", function () {
      // min = GL_NEAREST → min 'nearest', mipmap 'nearest', no mipmaps.
      const s = WebGPUSampler.createNearest();
      expect(s.descriptor.minFilter).toBe("nearest");
      expect(s.descriptor.magFilter).toBe("nearest");
      expect(s.descriptor.mipmapFilter).toBe("nearest");
      expect(s.usesMipmaps).toBe(false);
      expect(s.descriptor.label).toBe("NearestSampler");
    });
  });

  describe("static factory: createLinearMipmap", function () {
    it("builds a linear sampler using mipmaps", function () {
      // min = GL_LINEAR_MIPMAP_LINEAR → min 'linear', mipmap 'linear'.
      const s = WebGPUSampler.createLinearMipmap();
      expect(s.descriptor.minFilter).toBe("linear");
      expect(s.descriptor.magFilter).toBe("linear");
      expect(s.descriptor.mipmapFilter).toBe("linear");
      expect(s.usesMipmaps).toBe(true);
      expect(s.descriptor.label).toBe("LinearMipmapSampler");
    });
  });

  describe("static factory: createRepeatLinear", function () {
    it("builds a repeat-wrap linear mipmapped sampler", function () {
      const s = WebGPUSampler.createRepeatLinear();
      expect(s.descriptor.addressModeU).toBe("repeat");
      expect(s.descriptor.addressModeV).toBe("repeat");
      // wrapR is not set → defaults to clamp-to-edge.
      expect(s.descriptor.addressModeW).toBe("clamp-to-edge");
      expect(s.descriptor.minFilter).toBe("linear");
      expect(s.descriptor.mipmapFilter).toBe("linear");
      expect(s.usesMipmaps).toBe(true);
      expect(s.descriptor.label).toBe("RepeatLinearSampler");
    });
  });

  describe("static factory: createDepthComparisonSampler", function () {
    it("defaults the compare function to 'less'", function () {
      const s = WebGPUSampler.createDepthComparisonSampler();
      expect(s.descriptor.compare).toBe("less");
      expect(s.descriptor.minFilter).toBe("linear");
      expect(s.descriptor.magFilter).toBe("linear");
      expect(s.descriptor.label).toBe("DepthComparisonSampler");
    });

    it("honors an explicit compare function", function () {
      const s = WebGPUSampler.createDepthComparisonSampler("greater-equal");
      expect(s.descriptor.compare).toBe("greater-equal");
    });
  });

  describe("static factory: fromCesiumSampler", function () {
    it("copies wrap/filter/anisotropy fields from a Cesium Sampler shape", function () {
      const s = WebGPUSampler.fromCesiumSampler({
        wrapS: GL_REPEAT,
        wrapT: GL_MIRRORED_REPEAT,
        wrapR: GL_CLAMP_TO_EDGE,
        minificationFilter: GL_LINEAR_MIPMAP_LINEAR,
        magnificationFilter: GL_NEAREST,
        maximumAnisotropy: 8,
      });
      expect(s.descriptor.addressModeU).toBe("repeat");
      expect(s.descriptor.addressModeV).toBe("mirror-repeat");
      expect(s.descriptor.addressModeW).toBe("clamp-to-edge");
      expect(s.descriptor.minFilter).toBe("linear");
      expect(s.descriptor.mipmapFilter).toBe("linear");
      expect(s.descriptor.magFilter).toBe("nearest");
      expect(s.descriptor.maxAnisotropy).toBe(8);
      expect(s.usesMipmaps).toBe(true);
    });

    it("applies constructor defaults for omitted Cesium Sampler fields", function () {
      // An empty Cesium sampler → all constructor defaults.
      const s = WebGPUSampler.fromCesiumSampler({});
      expect(s.cacheKey).toBe(new WebGPUSampler().cacheKey);
    });
  });
});
