#!/usr/bin/env node
// wire-flat-shaders-aerial-lut.mjs — Batch 97 helper
//
// Mechanically applies the aerial-perspective LUT wiring to all Flat
// primitive shaders that don't have it yet. The reference template is
// `PrimitiveMatColorFlat.wgsl` (wired by hand in this batch).
//
// What it changes per shader:
//   1. Adds `@location(N) eyePosition: vec3<f32>` to VertexOutput at
//      the next free @location slot.
//   2. Adds `output.eyePosition = eyePos.xyz;` in vertexMain, right
//      after the existing position/normal assignments.
//   3. Adds the EffectsUniforms struct + bindings 0/7/8/9 at @group(N+1)
//      where N is the highest group already used (so the existing
//      texture group, if any, is unchanged).
//   4. Wraps `return X;` in fragmentMain with a fog-blend block.
//
// Skips shaders that already declare `atmosphereLutControl`.
//
// Run with: node Tools/wire-flat-shaders-aerial-lut.mjs

import fs from "fs";
import path from "path";

const SHADER_DIR = "packages/engine/Source/Shaders/WebGPU/Primitive";

const EFFECTS_STRUCT = `
// FEAT-GAP-09 (Batch 97) — truncated EffectsUniforms struct, sized to
// reach the \`atmosphereLutControl: vec4<f32>\` slot at byte offset 240
// in the shared 480-byte UBO (see \`WebGPUEffectsBindGroup.js\`). Reading
// less than the full UBO is safe — WGSL just sees the prefix.
struct EffectsUniforms {
    shadowMatrix: mat4x4<f32>,
    shadowMapSize: vec2<f32>,
    shadowDarkness: f32,
    shadowSoftShadows: f32,
    clippingPlaneCount: u32,
    clippingUnionMode: u32,
    clippingEdgeWidth: f32,
    clippingPolygonCount: u32,
    clippingEdgeColor: vec4<f32>,
    clipPlaneEqHW: array<vec4<f32>, 8>,
    atmosphereLutControl: vec4<f32>,
}
`;

const fogBlock = (varName = "finalColor") => `
    // FEAT-GAP-09 (Batch 97) — Aerial-perspective fog blend. Mirrors
    // \`PrimitiveBasicColor.wgsl::fragmentMain\`.
    if (effects.atmosphereLutControl.x > 0.5) {
        let innerRadius = effects.atmosphereLutControl.y;
        let thickness = max(1.0, effects.atmosphereLutControl.z);
        let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
        let viewDirWS = normalize(input.eyePosition);
        let upDir = normalize(cameraWC);
        let cosViewZenith = clamp(dot(viewDirWS, upDir), -1.0, 1.0);
        let cameraAltitude = max(0.0, length(cameraWC) - innerRadius);
        let uCoord = clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0);
        let vCoord = clamp(cameraAltitude / thickness, 0.0, 1.0);

        let tSample = textureSampleLevel(
            atmosphereTransmittanceLut, atmosphereLutSampler,
            vec2<f32>(uCoord, vCoord), 0.0,
        );
        let iSample = textureSampleLevel(
            atmosphereInscatterLut, atmosphereLutSampler,
            vec2<f32>(uCoord, vCoord), 0.0,
        );
        let transmittance =
            clamp((tSample.r + tSample.g + tSample.b) / 3.0, 0.0, 1.0);

        let excessAltitude = max(0.0, cameraAltitude - thickness);
        let orbitFalloff = exp(-excessAltitude / thickness);

        let fogWeight = clamp(iSample.a, 0.0, 1.0) * orbitFalloff;
        ${varName} = vec4<f32>(
            mix(${varName}.rgb, iSample.rgb, fogWeight),
            ${varName}.a,
        );
        if (effects.atmosphereLutControl.w > 0.5) {
            ${varName} = vec4<f32>(
                ${varName}.rgb * mix(1.0, transmittance, fogWeight),
                ${varName}.a,
            );
        }
    }
`;

const effectsBindings = (group) => `
@group(${group}) @binding(0) var<uniform> effects: EffectsUniforms;
// FEAT-GAP-09 (Batch 97) — aerial-perspective LUT bindings 7/8/9.
@group(${group}) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(${group}) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(${group}) @binding(9) var atmosphereLutSampler: sampler;
`;

function patch(filePath) {
  let src = fs.readFileSync(filePath, "utf8");
  const fileName = path.basename(filePath);

  if (src.includes("atmosphereLutControl")) {
    console.log(`  skip (already wired): ${fileName}`);
    return false;
  }

  // 1. Add eyePosition to VertexOutput. Find the highest @location(N)
  // already in the struct, append @location(N+1) eyePosition.
  const voMatch = src.match(/struct VertexOutput \{([\s\S]*?)\}/);
  if (!voMatch) {
    console.log(`  SKIP (no VertexOutput): ${fileName}`);
    return false;
  }
  const voBody = voMatch[1];
  const locs = [...voBody.matchAll(/@location\((\d+)\)/g)].map((m) =>
    Number(m[1]),
  );
  const nextLoc = locs.length === 0 ? 0 : Math.max(...locs) + 1;
  const newVO = voBody.replace(
    /(\s*)\}$/m,
    `$1    // FEAT-GAP-09 (Batch 97) — eye-space position for the fog block.\n$1    @location(${nextLoc}) eyePosition: vec3<f32>,\n`,
  );
  // Re-attach the closing brace
  src = src.replace(
    /struct VertexOutput \{[\s\S]*?\}/,
    `struct VertexOutput {${newVO}}`,
  );

  // 2. Inject `output.eyePosition = <var>.xyz;` in vertexMain. We
  // anchor on the existing `output.position = camera.mvpRelativeToEye * <var>;`
  // line. The local var name varies across shaders (`eyePos` /
  // `posRTE` / etc.), so capture it from the match.
  const mvpRe = /(\s+)output\.position\s*=\s*camera\.mvpRelativeToEye\s*\*\s*(\w+);/;
  const mvpMatch = src.match(mvpRe);
  if (!mvpMatch) {
    console.log(`  SKIP (no mvp*<var> line): ${fileName}`);
    return false;
  }
  const eyePosVar = mvpMatch[2];
  src = src.replace(
    mvpRe,
    `$1output.position = camera.mvpRelativeToEye * ${eyePosVar};$1output.eyePosition = ${eyePosVar}.xyz;`,
  );

  // 3. Compute which group the effects BG should attach at. Find the
  // highest @group(N) currently used, place effects at N+1.
  const groupNums = [...src.matchAll(/@group\((\d+)\)/g)].map((m) =>
    Number(m[1]),
  );
  const maxGroup = groupNums.length === 0 ? -1 : Math.max(...groupNums);
  const effectsGroup = maxGroup + 1;

  // Insert the EffectsUniforms struct + bindings AFTER the last existing
  // @group(N) @binding(M) declaration. We anchor on the closing newline
  // following the last such declaration.
  const allGroupBindingDecls = [
    ...src.matchAll(/@group\(\d+\)\s+@binding\(\d+\)[^\n]*\n/g),
  ];
  if (allGroupBindingDecls.length === 0) {
    console.log(`  SKIP (no @group bindings): ${fileName}`);
    return false;
  }
  const lastDecl = allGroupBindingDecls[allGroupBindingDecls.length - 1];
  const insertAt = lastDecl.index + lastDecl[0].length;
  src =
    src.slice(0, insertAt) +
    EFFECTS_STRUCT +
    effectsBindings(effectsGroup) +
    src.slice(insertAt);

  // 4. Wrap the fragmentMain's `return X;` with the fog block. Strategy:
  // find the LAST `return ...;` inside fragmentMain (handles multi-line
  // expressions like `return vec4<f32>(...);`), introduce a local var
  // `finalColor`, run fog block, return it.
  const fnMatch = src.match(
    /@fragment\s+fn fragmentMain\(input: VertexOutput\) -> @location\(0\) vec4<f32> \{([\s\S]*?)\n\}/,
  );
  if (!fnMatch) {
    console.log(`  SKIP (no fragmentMain): ${fileName}`);
    return false;
  }
  let body = fnMatch[1];
  // Find the LAST return statement in the body. Use a lazy match in
  // reverse by splitting on `return`.
  const lastReturnIdx = body.lastIndexOf("return ");
  if (lastReturnIdx < 0) {
    console.log(`  SKIP (no return in fragmentMain): ${fileName}`);
    return false;
  }
  const beforeReturn = body.slice(0, lastReturnIdx);
  const fromReturn = body.slice(lastReturnIdx);
  // Match the return expression up to its terminating `;`. Returns may
  // span multiple lines (e.g. `return vec4<f32>(\n  ...,\n);`).
  const exprMatch = fromReturn.match(/^return\s+([\s\S]*?);\s*$/);
  if (!exprMatch) {
    console.log(`  SKIP (couldn't parse return expr): ${fileName}`);
    return false;
  }
  const expr = exprMatch[1].trim();
  const indent = "    ";
  const wrapped = `${beforeReturn}var finalColor = ${expr};\n${fogBlock("finalColor")}\n${indent}return finalColor;\n`;
  src = src.replace(fnMatch[0], `${fnMatch[0].slice(0, fnMatch[0].indexOf("{") + 1)}${wrapped}}`);

  fs.writeFileSync(filePath, src, "utf8");
  console.log(`  wired (effects@group(${effectsGroup})): ${fileName}`);
  return true;
}

const shaders = fs
  .readdirSync(SHADER_DIR)
  .filter(
    (f) =>
      f.match(/^PrimitiveMat.*Flat\.wgsl$/) ||
      f === "PrimitiveBasicTexturedColor.wgsl",
  )
  // Skip the pick-only shader; pick path doesn't go through atmosphere.
  .filter((f) => f !== "PrimitivePickMatFlat.wgsl")
  .sort();

console.log(`[wire-flat-shaders] processing ${shaders.length} shaders`);
let wiredCount = 0;
for (const shader of shaders) {
  if (patch(path.join(SHADER_DIR, shader))) wiredCount++;
}
console.log(`[wire-flat-shaders] done — ${wiredCount} newly wired`);
