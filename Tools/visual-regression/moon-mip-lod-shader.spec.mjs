// moon-mip-lod-shader.spec.mjs — C12-33 Moon derivative/LOD contract.
// @purpose Structural WGSL contract for Moon derivative/LOD sampling, asserted per @fragment entry point: exactly one ellipsoid hit shaded, explicit gradients, no duplicated color evaluation.
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

// Moon.wgsl carries two @fragment entry points: `fs` for the legacy pass and
// `fsPhysical` for the depth-participating one. Whole-file match counts and
// indexOf() ordering silently read only the first of them, so every locality
// claim below is asserted against an individually brace-matched body instead.
function fragmentEntryPoints(source) {
  const entries = [];
  const header = /@fragment\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = header.exec(source)) !== null) {
    const open = source.indexOf("{", header.lastIndex);
    assert.ok(open > 0, `@fragment fn ${match[1]} has no body`);
    let depth = 0;
    let close = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") {
        depth += 1;
      } else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    assert.ok(close > open, `@fragment fn ${match[1]} has an unbalanced body`);
    entries.push({
      name: match[1],
      start: match.index,
      body: source.slice(open + 1, close),
    });
  }
  return entries;
}

const fragmentEntries = fragmentEntryPoints(codeOnly);

test("opaque front/back selection shades exactly one valid ellipsoid hit", () => {
  assert.equal(
    fragmentEntries.length,
    2,
    "expected the legacy and depth-participating Moon fragment entry points",
  );

  for (const { name, body } of fragmentEntries) {
    assert.match(body, /let outsideHit = ts\.x >= 0\.0;/, name);
    assert.match(body, /let tHit = select\(ts\.y, ts\.x, outsideHit\);/, name);
    assert.match(body, /let side = select\(-1\.0, 1\.0, outsideHit\);/, name);
    assert.match(
      body,
      /let hitColor = computeEllipsoidColor\(hitMC, side, uv, uvDx, uvDy\);/,
      name,
    );

    // One call per body. A second would duplicate the Moon's full
    // texture/normal/lighting work for an unobservable opaque face.
    assert.equal(
      (body.match(/computeEllipsoidColor\s*\(/g) ?? []).length,
      1,
      `${name} must shade exactly one hit`,
    );
    assert.doesNotMatch(body, /outsideColor|insideColor/, name);

    // The final target stays unconditionally opaque. That is the invariant
    // making one-hit selection equivalent to the old general-purpose alpha
    // composite used by EllipsoidFS.glsl.
    assert.match(
      body,
      /out\.color = vec4<f32>\(hitColor\.rgb \* u\.extinction \+ u\.inscatter, 1\.0\);/,
      name,
    );
  }

  // One shared declaration plus exactly one call from each entry body — this
  // catches a stray third caller introduced anywhere else in the file.
  assert.equal(
    (codeOnly.match(/computeEllipsoidColor\s*\(/g) ?? []).length,
    fragmentEntries.length + 1,
  );
  // The material itself is pinned opaque inside the shared helper.
  assert.match(codeOnly, /m\.alpha = 1\.0;/);
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

  const helperDeclaration = codeOnly.indexOf("fn computeEllipsoidColor(");
  assert.ok(helperDeclaration > 0, "the shared shading helper must exist");

  for (const { name, start, body } of fragmentEntries) {
    assert.ok(
      helperDeclaration < start,
      `the textureSampleGrad helper must be declared before ${name}`,
    );

    const derivativeX = body.indexOf("var uvDx = dpdx(uv);");
    const derivativeY = body.indexOf("var uvDy = dpdy(uv);");
    const firstDiscard = body.indexOf("discard;");
    assert.ok(
      derivativeX >= 0 && derivativeY >= 0,
      `${name} must compute explicit UV derivatives`,
    );
    assert.ok(
      firstDiscard > derivativeX && firstDiscard > derivativeY,
      `${name}: dpdx/dpdy must execute before the body's first fragment-varying discard`,
    );

    // Sampling belongs to the shared helper; the body only forwards the
    // gradients it computed itself, so no body samples on its own.
    assert.doesNotMatch(
      body,
      /textureSampleGrad\s*\(/,
      `${name} must sample through the shared helper`,
    );
  }
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
  for (const { name, body } of fragmentEntries) {
    assert.match(body, /var uvDx = dpdx\(uv\);/, name);
    assert.match(body, /var uvDy = dpdy\(uv\);/, name);
    assert.match(body, /uvDx\.x = uvDx\.x - round\(uvDx\.x\);/, name);
    assert.match(body, /uvDy\.x = uvDy\.x - round\(uvDy\.x\);/, name);
  }
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
