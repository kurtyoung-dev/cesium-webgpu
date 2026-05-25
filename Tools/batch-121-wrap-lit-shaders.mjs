#!/usr/bin/env node
// Batch 121 helper — convert the 19 Mat Lit + 2 Phong primitive shaders
// to emit FragOutput so they populate G-buffer slot 1.
//
// Why a helper instead of 21 hand-edits: the conversion is uniform.
// Every file has:
//   - exactly 1 `@fragment` entry
//   - signature `-> @location(0) vec4<f32>`
//   - exactly 1 `return EXPR;` inside the entry body
//   - `input.worldNormal` available (vertex stage writes it as eye-space
//     normal via `camera.normalMatrix * input.normal`, despite the
//     misleading field name).
//
// The script transforms each file in place:
//   1. Inserts a `FragOutput` struct definition right before `@fragment`.
//   2. Rewrites the signature `-> @location(0) vec4<f32>` → `-> FragOutput`.
//   3. Wraps the single return: `return X;` →
//      `var __mrtOut: FragOutput; __mrtOut.color = X;
//       __mrtOut.normalRoughness = vec4<f32>(normalize(input.worldNormal), 0.5);
//       return __mrtOut;`
//
// NormalMap + BumpMap shaders have a post-perturbation normal available
// (`perturbedNormal` and similar) that would produce a much wider Slice 4
// signal than the geometric `worldNormal`. Those are flagged for manual
// fixup in a follow-up — for now they emit the geometric normal too,
// preserving correctness (consumer sees the silhouette normal) at the
// cost of not yet exercising the normal-map perturbation divergence.
//
// Bails if any file's structure differs from the expected pattern.

import fs from "fs";
import path from "path";

const SHADER_DIR = "packages/engine/Source/Shaders/WebGPU/Primitive";
const FILES = [
  "PrimitiveMatAlphaMapLit.wgsl",
  "PrimitiveMatAspectRampLit.wgsl",
  "PrimitiveMatBumpMapLit.wgsl",
  "PrimitiveMatCheckerLit.wgsl",
  "PrimitiveMatColorLit.wgsl",
  "PrimitiveMatDotLit.wgsl",
  "PrimitiveMatElevBandLit.wgsl",
  "PrimitiveMatElevContourLit.wgsl",
  "PrimitiveMatElevRampLit.wgsl",
  "PrimitiveMatEmissionMapLit.wgsl",
  "PrimitiveMatFadeLit.wgsl",
  "PrimitiveMatGridLit.wgsl",
  "PrimitiveMatImageLit.wgsl",
  "PrimitiveMatNormalMapLit.wgsl",
  "PrimitiveMatRimLightingLit.wgsl",
  "PrimitiveMatSlopeRampLit.wgsl",
  "PrimitiveMatSpecularMapLit.wgsl",
  "PrimitiveMatStripeLit.wgsl",
  "PrimitiveMatWaterLit.wgsl",
  "PrimitivePhongColor.wgsl",
  "PrimitivePhongTexturedColor.wgsl",
];

const FRAG_OUTPUT_STRUCT = `// Slice 5c-B Batch 121 — G-buffer MRT output struct (added by
// Tools/batch-121-wrap-lit-shaders.mjs). Slot 0 = lit color, slot 1 =
// eye-space normal + roughness. NormalMap / BumpMap variants emit the
// geometric vertex normal for now; a follow-up batch can switch them
// to their perturbed-normal variable for wider Slice 4 divergence.
struct FragOutput {
    @location(0) color: vec4<f32>,
    @location(1) normalRoughness: vec4<f32>,
};

`;

const SIG_RE = /(@fragment\s*\n\s*fn fragmentMain\([\s\S]*?\)) -> @location\(0\) vec4<f32> \{/;

function transformFile(filePath) {
  const src = fs.readFileSync(filePath, "utf8");

  // 1. Find @fragment line + ensure struct not already present.
  if (src.includes("struct FragOutput")) {
    return { skipped: "already converted", file: filePath };
  }

  // 2. Locate the @fragment block + rewrite signature.
  const sigMatch = SIG_RE.exec(src);
  if (!sigMatch) {
    return { error: "no @fragment fn fragmentMain ... -> @location(0) vec4<f32>", file: filePath };
  }
  const newSig = `${sigMatch[1]} -> FragOutput {`;

  // 3. Insert struct before the @fragment line.
  const fragmentIdx = src.lastIndexOf("@fragment", sigMatch.index);
  const before = src.slice(0, fragmentIdx);
  const after = src.slice(fragmentIdx);
  let withStruct = before + FRAG_OUTPUT_STRUCT + after;

  // 4. Replace signature.
  withStruct = withStruct.replace(sigMatch[0], newSig);

  // 5. Find the LAST `return EXPR;` before the next `}` at zero brace
  //    depth. Walk forward from the end of the @fragment signature.
  const sigEnd = withStruct.indexOf(newSig) + newSig.length;
  let depth = 1;
  let i = sigEnd;
  let lastReturnStart = -1;
  let lastReturnEnd = -1;
  while (i < withStruct.length && depth > 0) {
    const ch = withStruct[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1) {
      // Look for `return ` at this position
      if (withStruct.startsWith("return ", i)) {
        // Find the matching `;`
        let j = i + 7;
        let parenDepth = 0;
        while (j < withStruct.length) {
          if (withStruct[j] === "(") parenDepth++;
          else if (withStruct[j] === ")") parenDepth--;
          else if (withStruct[j] === ";" && parenDepth === 0) {
            lastReturnStart = i;
            lastReturnEnd = j + 1;
            break;
          }
          j++;
        }
      }
    }
    i++;
  }
  if (lastReturnStart < 0) {
    return { error: "no return found inside fragment body", file: filePath };
  }

  // Extract the indent of the return line so the rewrite preserves
  // formatting.
  let indentStart = lastReturnStart;
  while (indentStart > 0 && withStruct[indentStart - 1] !== "\n") {
    indentStart--;
  }
  const indent = withStruct.slice(indentStart, lastReturnStart);
  const returnExpr = withStruct.slice(
    lastReturnStart + "return ".length,
    lastReturnEnd - 1, // exclude the `;`
  );

  const wrapped =
    `${indent}// Slice 5c-B Batch 121 — emit FragOutput. normalRoughness gets the\n` +
    `${indent}// geometric eye-space normal (vertex shader writes worldNormal as\n` +
    `${indent}// eye-space via camera.normalMatrix). Roughness 0.5 placeholder —\n` +
    `${indent}// Lit Mat shaders don't carry material roughness in their UBOs.\n` +
    `${indent}var __mrtOut: FragOutput;\n` +
    `${indent}__mrtOut.color = ${returnExpr};\n` +
    `${indent}__mrtOut.normalRoughness = vec4<f32>(normalize(input.worldNormal), 0.5);\n` +
    `${indent}return __mrtOut;`;

  const transformed =
    withStruct.slice(0, indentStart) +
    wrapped +
    withStruct.slice(lastReturnEnd);

  return { transformed, file: filePath };
}

let converted = 0;
let skipped = 0;
const errors = [];
for (const name of FILES) {
  const filePath = path.join(SHADER_DIR, name);
  const result = transformFile(filePath);
  if (result.error) {
    errors.push(`${name}: ${result.error}`);
    continue;
  }
  if (result.skipped) {
    console.log(`  skip ${name}: ${result.skipped}`);
    skipped++;
    continue;
  }
  fs.writeFileSync(filePath, result.transformed, "utf8");
  console.log(`  wrap ${name}`);
  converted++;
}

console.log(`\nconverted: ${converted}, skipped: ${skipped}, errors: ${errors.length}`);
if (errors.length) {
  errors.forEach((e) => console.error("  ERROR " + e));
  process.exit(1);
}
