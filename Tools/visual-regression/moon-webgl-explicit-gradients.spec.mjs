// C12-33 WebGL Moon explicit-gradient structural contract.
// @purpose Structural GLSL contract: Moon UV derivatives execute before miss discards under LUNAR_EXPLICIT_GRADIENTS on the WebGL path.
// @status ACTIVE
//
// Run:
//   node --test Tools/visual-regression/moon-webgl-explicit-gradients.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import demodernizeShader from "../../packages/engine/Source/Renderer/demodernizeShader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const ellipsoidShader = read("packages/engine/Source/Shaders/EllipsoidFS.glsl");
const moonMaterial = read(
  "packages/engine/Source/Scene/WebGLMoonImageMaterial.js",
);
const material = read("packages/engine/Source/Scene/Material.js");
const ellipsoidPrimitive = read(
  "packages/engine/Source/Scene/EllipsoidPrimitive.js",
);
const moon = read("packages/engine/Source/Scene/Moon.js");

test("Moon UV derivatives execute before either Moon-path miss discard", () => {
  assert.match(
    ellipsoidShader,
    /#ifdef LUNAR_EXPLICIT_GRADIENTS\s+bool missesBoundingSphere[\s\S]*?#else\s+if \(t1 < 0\.0 && t2 < 0\.0\) \{\s+discard;\s+\}\s+#endif/,
  );

  const firstDerivative = ellipsoidShader.indexOf(
    "dFdx(outsideTextureCoordinates)",
  );
  const lastDerivative = ellipsoidShader.indexOf(
    "dFdy(insideTextureCoordinates)",
  );
  const moonMissDiscard = ellipsoidShader.indexOf(
    "if (missesBoundingSphere || missesEllipsoid)",
  );
  assert.ok(firstDerivative > 0);
  assert.ok(lastDerivative > firstDerivative);
  assert.ok(moonMissDiscard > lastDerivative);

  assert.match(
    ellipsoidShader,
    /float closestIntersection = max\([\s\S]*?-dot\(scaledOrigin, scaledDirection\)[\s\S]*?scaledDirectionSquared/,
  );
  assert.match(
    ellipsoidShader,
    /scaledOrigin = ellipsoid_inverseRadii \*[\s\S]*?czm_inverseModelView \* vec4\(ray\.origin, 1\.0\)/,
  );
  assert.match(
    ellipsoidShader,
    /scaledOrigin -= ellipsoid_inverseRadii \*[\s\S]*?czm_inverseModelView \* vec4\(ellipsoidCenter, 1\.0\)/,
  );
  assert.match(
    ellipsoidShader,
    /scaledDirection = ellipsoid_inverseRadii \*[\s\S]*?czm_inverseModelView \* vec4\(ray\.direction, 0\.0\)/,
  );
  assert.doesNotMatch(
    ellipsoidShader,
    /outsideTextureIntersection\s*=\s*missesEllipsoid\s*\?\s*-1\.0/,
  );
});

test("longitude gradients unwrap and both Moon channels use explicit gradients", () => {
  assert.match(ellipsoidShader, /gradient\.x -= floor\(gradient\.x \+ 0\.5\);/);
  assert.doesNotMatch(ellipsoidShader, /gradient\.y\s*-=/);
  assert.match(
    ellipsoidShader,
    /return textureGrad\(textureSampler, textureCoordinates, dx, dy\);/,
  );
  assert.match(
    ellipsoidShader,
    /return texture2DGradEXT\(textureSampler, textureCoordinates, dx, dy\);/,
  );
  assert.match(
    moonMaterial,
    /sampleWebGLMoonTexture\(image, textureCoordinates, repeat\)/,
  );
  assert.match(
    ellipsoidShader,
    /sampleWebGLMoonTexture\(u_lunarNormalMap, st, vec2\(1\.0\)\)/,
  );
});

test("WebGL 1 demodernization retains the extension gradient path", () => {
  const webGL1Shader = demodernizeShader(ellipsoidShader, true);

  assert.match(webGL1Shader, /^#version 100/);
  assert.match(webGL1Shader, /#extension GL_EXT_shader_texture_lod : enable/);
  assert.match(webGL1Shader, /#extension GL_OES_standard_derivatives : enable/);
  assert.match(
    webGL1Shader,
    /texture2DGradEXT\(textureSampler, textureCoordinates, dx, dy\)/,
  );
  assert.match(
    webGL1Shader,
    /return texture2D\(textureSampler, textureCoordinates\);/,
  );
});

test("private Moon material preserves Image material semantics", () => {
  assert.match(
    moonMaterial,
    /vec2 textureCoordinates = fract\(repeat \* materialInput\.st\);/,
  );
  assert.match(
    moonMaterial,
    /material\.diffuse = czm_gammaCorrect\(imageColor\.rgb \* color\.rgb\);/,
  );
  assert.match(moonMaterial, /material\.alpha = imageColor\.a \* color\.a;/);

  const imageTypeStart = material.indexOf('Material.ImageType = "Image"');
  const diffuseMapStart = material.indexOf(
    "Material.DiffuseMapType",
    imageTypeStart,
  );
  const genericImageMaterial = material.slice(imageTypeStart, diffuseMapStart);
  assert.match(
    genericImageMaterial,
    /texture\(image, fract\(repeat \* materialInput\.st\)\)/,
  );
  assert.doesNotMatch(genericImageMaterial, /textureGrad|WebGLMoon|LUNAR_/);

  assert.match(
    ellipsoidShader,
    /vec4 outsideFaceColor = \(intersection\.start != 0\.0\) \? computeEllipsoidColor\(ray, intersection\.start, 1\.0\) : vec4\(0\.0\);/,
  );
  assert.match(
    ellipsoidShader,
    /vec4 insideFaceColor = \(outsideFaceColor\.a < 1\.0\) \? computeEllipsoidColor\(ray, intersection\.stop, -1\.0\) : vec4\(0\.0\);/,
  );
  assert.match(
    ellipsoidShader,
    /out_FragColor = mix\(insideFaceColor, outsideFaceColor, outsideFaceColor\.a\);/,
  );
  assert.match(
    ellipsoidShader,
    /out_FragColor\.a = 1\.0 - \(1\.0 - insideFaceColor\.a\) \* \(1\.0 - outsideFaceColor\.a\);/,
  );
});

test("Moon-only channel defines are tracked by color and pick programs", () => {
  assert.match(moon, /material: createWebGLMoonImageMaterial\(\)/);
  assert.match(
    moon,
    /canGenerateWebGLMoonMipmaps\(\s*context,\s*albedoTexture\.width,\s*albedoTexture\.height/,
  );
  assert.match(
    moon,
    /canGenerateWebGLMoonMipmaps\(\s*context,\s*normalTexture\.width,\s*normalTexture\.height/,
  );
  assert.match(moon, /moonTextureMipLevelCount: albedoMipLevelCount/);
  assert.match(moon, /normalTextureMipLevelCount: normalMipLevelCount/);
  assert.match(
    ellipsoidPrimitive,
    /this\.lunarAlbedoExplicitGradients = false;/,
  );
  assert.match(
    ellipsoidPrimitive,
    /this\.lunarNormalExplicitGradients = false;/,
  );
  assert.equal(
    (
      ellipsoidPrimitive.match(
        /fs\.defines\.push\("LUNAR_ALBEDO_EXPLICIT_GRADIENTS"\)/g,
      ) ?? []
    ).length,
    2,
    "color and pick programs must both opt the private albedo material in",
  );
});

test("front/back alpha composite remains mathematically intact", () => {
  const composite = (inside, outside) => ({
    rgb: inside.rgb * (1.0 - outside.alpha) + outside.rgb * outside.alpha,
    alpha: 1.0 - (1.0 - inside.alpha) * (1.0 - outside.alpha),
  });

  assert.deepEqual(
    composite({ rgb: 0.2, alpha: 0.25 }, { rgb: 0.8, alpha: 0.5 }),
    { rgb: 0.5, alpha: 0.625 },
  );
  assert.deepEqual(
    composite({ rgb: 0.2, alpha: 0.25 }, { rgb: 0.8, alpha: 1.0 }),
    { rgb: 0.8, alpha: 1.0 },
  );
});
