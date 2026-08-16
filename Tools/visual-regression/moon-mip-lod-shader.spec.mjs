// moon-mip-lod-shader.spec.mjs — C12-33 Moon derivative/LOD contract.
// @purpose Structural WGSL contract for Moon derivative/LOD sampling: exactly one ellipsoid hit shaded, explicit gradients, no duplicated color evaluation.
// @status ACTIVE
//
// Run:
//   node --test Tools/visual-regression/moon-mip-lod-shader.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const shaderPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
);
const shaderSource = fs.readFileSync(shaderPath, "utf8");
const codeOnly = shaderSource
  .split("\n")
  .map((line) => {
    const slash = line.indexOf("//");
    return slash >= 0 ? line.slice(0, slash) : line;
  })
  .join("\n");

test("opaque front/back selection shades exactly one valid ellipsoid hit", () => {
  assert.match(codeOnly, /let outsideHit = ts\.x >= 0\.0;/);
  assert.match(codeOnly, /let tHit = select\(ts\.y, ts\.x, outsideHit\);/);
  assert.match(codeOnly, /let side = select\(-1\.0, 1\.0, outsideHit\);/);
  assert.match(
    codeOnly,
    /let hitColor = computeEllipsoidColor\(hitMC, side, uv, uvDx, uvDy\);/,
  );

  // One declaration plus one call. A second call would duplicate the Moon's
  // full texture/normal/lighting work for an unobservable opaque face.
  assert.equal((codeOnly.match(/computeEllipsoidColor\s*\(/g) ?? []).length, 2);
  assert.doesNotMatch(codeOnly, /outsideColor|insideColor/);

  // Both the material and final target remain unconditionally opaque. This
  // is the invariant that makes selecting one hit equivalent to the old
  // general-purpose alpha composite used by EllipsoidFS.glsl.
  assert.match(codeOnly, /m\.alpha = 1\.0;/);
  assert.match(
    codeOnly,
    /out\.color = vec4<f32>\(hitColor\.rgb \* u\.extinction \+ u\.inscatter, 1\.0\);/,
  );
});

test("albedo and normal use explicit pre-discard gradients with independent texture LOD", () => {
  assert.match(codeOnly, /textureSampleGrad\(tex, samp, uv, uvDx, uvDy\)/);
  assert.match(
    codeOnly,
    /textureSampleGrad\(normalTex, samp, uv, uvDx, uvDy\)/,
  );
  assert.doesNotMatch(
    codeOnly,
    /textureSampleLevel\(\s*(?:tex|normalTex)\b/,
    "Moon textures must not be pinned to mip zero",
  );
  assert.doesNotMatch(
    codeOnly,
    /textureSample\(\s*(?:tex|normalTex)\b/,
    "implicit derivatives are unsafe after a fragment-varying miss discard",
  );

  const derivativeIndex = codeOnly.indexOf("var uvDx = dpdx(uv);");
  const discardIndex = codeOnly.indexOf("discard;", derivativeIndex);
  const sampleIndex = codeOnly.indexOf("textureSampleGrad(tex");
  assert.ok(derivativeIndex > 0, "UV derivatives must be explicit");
  assert.ok(
    discardIndex > derivativeIndex,
    "dpdx/dpdy must execute before the fragment-varying miss discard",
  );
  assert.ok(
    sampleIndex < derivativeIndex,
    "the textureSampleGrad helper must be declared before fs computes gradients",
  );
});

test("miss-helper UVs are limb-continuous and longitude gradients unwrap", () => {
  assert.match(codeOnly, /sqrt\(max\(disc, 0\.0\)\)/);
  assert.match(
    codeOnly,
    /return EllipsoidIntersection\(vec2<f32>\(t0, t1\), disc\);/,
  );
  assert.doesNotMatch(
    codeOnly,
    /vec2<f32>\(-1\.0, -1\.0\)/,
    "a fixed miss sentinel would poison derivatives in limb-adjacent quads",
  );
  assert.match(codeOnly, /var uvDx = dpdx\(uv\);/);
  assert.match(codeOnly, /var uvDy = dpdy\(uv\);/);
  assert.match(codeOnly, /uvDx\.x = uvDx\.x - round\(uvDx\.x\);/);
  assert.match(codeOnly, /uvDy\.x = uvDy\.x - round\(uvDy\.x\);/);
  assert.doesNotMatch(
    codeOnly,
    /uvD[xy]\.y\s*=.*round/,
    "latitude is clamped at the poles and must not be made periodic",
  );
});

test("inside and outside hit selection covers every non-discarded interval", () => {
  const selectedHit = (near, far) => {
    assert.ok(
      near >= 0 || far >= 0,
      "the shader discards an all-negative interval",
    );
    const outside = near >= 0;
    return {
      t: outside ? near : far,
      side: outside ? 1 : -1,
    };
  };

  assert.deepEqual(selectedHit(2, 5), { t: 2, side: 1 });
  assert.deepEqual(selectedHit(-2, 5), { t: 5, side: -1 });
  assert.deepEqual(selectedHit(0, 5), { t: 0, side: 1 });
});

test("Moon.wgsl passes naga validation with explicit derivatives", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() => naga.validate_wgsl(shaderSource));
});
