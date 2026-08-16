// @purpose Behavioral tests of the WebGL moon mip policy: NPOT mip generation under WebGL2, trilinear/linear sampler selection, mip level counts.
// @status ACTIVE

import test from "node:test";
import assert from "node:assert/strict";

import TextureMinificationFilter from "../../packages/engine/Source/Renderer/TextureMinificationFilter.js";
import TextureWrap from "../../packages/engine/Source/Renderer/TextureWrap.js";
import { configureWebGLMoonTextureCandidate } from "../../packages/engine/Source/Scene/Moon.js";
import {
  canGenerateWebGLMoonMipmaps,
  configureWebGLMoonTextureMipmaps,
  getWebGLMoonTextureMipLevelCount,
  webGLMoonLinearSampler,
  webGLMoonTrilinearSampler,
} from "../../packages/engine/Source/Scene/WebGLMoonTextureMipPolicy.js";

function createTexture(width, height) {
  return {
    width,
    height,
    sampler: undefined,
    mipGenerations: 0,
    generateMipmap() {
      this.mipGenerations++;
    },
  };
}

test("WebGL 2 Moon textures generate mipmaps for NPOT overrides", () => {
  const texture = createTexture(1536, 768);

  assert.equal(canGenerateWebGLMoonMipmaps({ webgl2: true }, 1536, 768), true);
  assert.equal(
    configureWebGLMoonTextureMipmaps(texture, { webgl2: true }),
    true,
  );
  assert.equal(texture.mipGenerations, 1);
  assert.equal(getWebGLMoonTextureMipLevelCount(texture), 11);
  assert.equal(texture.sampler, webGLMoonTrilinearSampler);
  assert.equal(
    texture.sampler.minificationFilter,
    TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
  );
  assert.equal(texture.sampler.wrapS, TextureWrap.REPEAT);
  assert.equal(texture.sampler.wrapT, TextureWrap.CLAMP_TO_EDGE);
});

test("WebGL 1 Moon textures generate mipmaps for power-of-two assets", () => {
  const texture = createTexture(2048, 1024);
  const context = {
    webgl2: false,
    standardDerivatives: true,
    supportsTextureLod: true,
  };

  assert.equal(canGenerateWebGLMoonMipmaps(context, 2048, 1024), true);
  assert.equal(configureWebGLMoonTextureMipmaps(texture, context), true);
  assert.equal(texture.mipGenerations, 1);
  assert.equal(getWebGLMoonTextureMipLevelCount(texture), 12);
  assert.equal(texture.sampler, webGLMoonTrilinearSampler);
});

test("WebGL 1 POT textures require both explicit-gradient extensions", () => {
  for (const context of [
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
  ]) {
    const texture = createTexture(2048, 1024);
    assert.equal(canGenerateWebGLMoonMipmaps(context, 2048, 1024), false);
    assert.equal(configureWebGLMoonTextureMipmaps(texture, context), false);
    assert.equal(texture.mipGenerations, 0);
    assert.equal(getWebGLMoonTextureMipLevelCount(texture), 1);
    assert.equal(texture.sampler, webGLMoonLinearSampler);
  }
});

test("WebGL 1 NPOT Moon textures retain single-level LINEAR sampling", () => {
  const texture = createTexture(1536, 768);
  const context = {
    webgl2: false,
    standardDerivatives: true,
    supportsTextureLod: true,
  };

  assert.equal(canGenerateWebGLMoonMipmaps(context, 1536, 768), false);
  assert.equal(configureWebGLMoonTextureMipmaps(texture, context), false);
  assert.equal(texture.mipGenerations, 0);
  assert.equal(getWebGLMoonTextureMipLevelCount(texture), 1);
  assert.equal(texture.sampler, webGLMoonLinearSampler);
  assert.equal(
    texture.sampler.minificationFilter,
    TextureMinificationFilter.LINEAR,
  );
  assert.equal(texture.sampler.wrapS, TextureWrap.CLAMP_TO_EDGE);
  assert.equal(texture.sampler.wrapT, TextureWrap.CLAMP_TO_EDGE);
});

test("an unknown context capability takes the WebGL 1-safe fallback", () => {
  const texture = createTexture(1000, 500);

  assert.equal(canGenerateWebGLMoonMipmaps({}, 1000, 500), false);
  assert.equal(configureWebGLMoonTextureMipmaps(texture, {}), false);
  assert.equal(texture.mipGenerations, 0);
  assert.equal(getWebGLMoonTextureMipLevelCount(texture), 1);
  assert.equal(texture.sampler, webGLMoonLinearSampler);
});

test("missing textures report no realized mip chain", () => {
  assert.equal(getWebGLMoonTextureMipLevelCount(undefined), null);
});

test("a failed Moon mip configuration destroys the unpublished candidate", () => {
  const configurationError = new Error("synthetic mip failure");
  let destroyCount = 0;
  const texture = {
    width: 2048,
    height: 1024,
    generateMipmap() {
      throw configurationError;
    },
    isDestroyed() {
      return false;
    },
    destroy() {
      destroyCount++;
      // Cleanup errors are secondary and must not mask mip failure.
      throw new Error("synthetic destroy failure");
    },
  };

  let caught;
  try {
    configureWebGLMoonTextureCandidate(texture, { webgl2: true });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, configurationError);
  assert.equal(destroyCount, 1);
});
