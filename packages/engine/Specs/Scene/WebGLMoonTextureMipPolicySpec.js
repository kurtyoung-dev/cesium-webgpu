import TextureMinificationFilter from "../../Source/Renderer/TextureMinificationFilter.js";
import TextureWrap from "../../Source/Renderer/TextureWrap.js";
import {
  canGenerateWebGLMoonMipmaps,
  configureWebGLMoonTextureMipmaps,
  getWebGLMoonTextureMipLevelCount,
  webGLMoonLinearSampler,
  webGLMoonTrilinearSampler,
} from "../../Source/Scene/WebGLMoonTextureMipPolicy.js";

function createTexture(width, height) {
  return {
    width,
    height,
    sampler: undefined,
    mipGenerations: 0,
    generateMipmap: function () {
      this.mipGenerations++;
    },
  };
}

describe("Scene/WebGLMoonTextureMipPolicy", function () {
  it("uses trilinear mip sampling for WebGL 2 NPOT textures", function () {
    const texture = createTexture(1536, 768);

    expect(canGenerateWebGLMoonMipmaps({ webgl2: true }, 1536, 768)).toBe(true);
    expect(configureWebGLMoonTextureMipmaps(texture, { webgl2: true })).toBe(
      true,
    );
    expect(texture.mipGenerations).toBe(1);
    expect(getWebGLMoonTextureMipLevelCount(texture)).toBe(11);
    expect(texture.sampler).toBe(webGLMoonTrilinearSampler);
    expect(texture.sampler.minificationFilter).toBe(
      TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
    );
    expect(texture.sampler.wrapS).toBe(TextureWrap.REPEAT);
    expect(texture.sampler.wrapT).toBe(TextureWrap.CLAMP_TO_EDGE);
  });

  it("uses trilinear mip sampling for WebGL 1 POT textures", function () {
    const texture = createTexture(2048, 1024);
    const context = {
      webgl2: false,
      standardDerivatives: true,
      supportsTextureLod: true,
    };

    expect(canGenerateWebGLMoonMipmaps(context, 2048, 1024)).toBe(true);
    expect(configureWebGLMoonTextureMipmaps(texture, context)).toBe(true);
    expect(texture.mipGenerations).toBe(1);
    expect(getWebGLMoonTextureMipLevelCount(texture)).toBe(12);
    expect(texture.sampler).toBe(webGLMoonTrilinearSampler);
  });

  it("requires both WebGL 1 explicit-gradient extensions", function () {
    const contexts = [
      {
        webgl2: false,
        standardDerivatives: false,
        supportsTextureLod: true,
      },
      {
        webgl2: false,
        standardDerivatives: true,
        supportsTextureLod: false,
      },
    ];

    for (const context of contexts) {
      const texture = createTexture(2048, 1024);
      expect(canGenerateWebGLMoonMipmaps(context, 2048, 1024)).toBe(false);
      expect(configureWebGLMoonTextureMipmaps(texture, context)).toBe(false);
      expect(texture.mipGenerations).toBe(0);
      expect(getWebGLMoonTextureMipLevelCount(texture)).toBe(1);
      expect(texture.sampler).toBe(webGLMoonLinearSampler);
    }
  });

  it("keeps WebGL 1 NPOT textures single-level and LINEAR", function () {
    const texture = createTexture(1536, 768);
    const context = {
      webgl2: false,
      standardDerivatives: true,
      supportsTextureLod: true,
    };

    expect(canGenerateWebGLMoonMipmaps(context, 1536, 768)).toBe(false);
    expect(configureWebGLMoonTextureMipmaps(texture, context)).toBe(false);
    expect(texture.mipGenerations).toBe(0);
    expect(getWebGLMoonTextureMipLevelCount(texture)).toBe(1);
    expect(texture.sampler).toBe(webGLMoonLinearSampler);
    expect(texture.sampler.minificationFilter).toBe(
      TextureMinificationFilter.LINEAR,
    );
    expect(texture.sampler.wrapS).toBe(TextureWrap.CLAMP_TO_EDGE);
    expect(texture.sampler.wrapT).toBe(TextureWrap.CLAMP_TO_EDGE);
  });

  it("reports no mip chain for a missing realization", function () {
    expect(getWebGLMoonTextureMipLevelCount(undefined)).toBeNull();
  });
});
