#!/usr/bin/env node
// wire-globe-mrt-normal.mjs — Slice 5c-B1 helper (Batch 105).
//
// Rewrites GlobeTerrain.wgsl's fragmentMain to output a 2-attachment
// struct {color @location(0), normalRoughness @location(1)} instead of
// a single @location(0). Globe pipeline gains a 2nd color attachment
// pointed at the G-buffer normal-roughness texture, replacing the
// depth-derived compute producer's contribution on globe pixels.
//
// Changes applied:
//   1. After the VertexOutput struct, insert FragOutput + makeOutput helper.
//   2. Change fragmentMain signature to return FragOutput.
//   3. Replace every `return <expr>;` inside fragmentMain with
//      `return makeOutput(<expr>, input.v_normalEC);`.
//
// Idempotent — skips files that already declare FragOutput.

import fs from "fs";

const FILE = "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";

const FRAG_STRUCT_AND_HELPER = `
// FEAT-GAP-09 / Slice 5c-B1 (Batch 105) — MRT output for the globe
// surface. @location(0) is the standard scene color; @location(1) is
// the G-buffer normal-roughness texture (rgba16float). Replaces the
// compute-pass depth-derived normals on globe pixels with real eye-
// space normals from \`v_normalEC\` (computed in vertexMain from the
// terrain mesh's geodetic surface normal — much more accurate than
// depth-gradient reconstruction at silhouettes and flat surfaces).
// Roughness is hardcoded to 0.5 here — material-driven roughness is
// a separate Slice 5d / 5c-C arc.
struct FragOutput {
  @location(0) color: vec4<f32>,
  @location(1) normalRoughness: vec4<f32>,
}

fn makeFragOutput(color: vec4<f32>, normalEC: vec3<f32>) -> FragOutput {
  var o: FragOutput;
  o.color = color;
  o.normalRoughness = vec4<f32>(normalize(normalEC), 0.5);
  return o;
}

`;

function patch() {
  let src = fs.readFileSync(FILE, "utf8");
  // Normalize CRLF → LF so the regex/string searches work uniformly.
  // Will write back with the same endings the file already has (Git's
  // autocrlf handles the round-trip).
  const hadCRLF = src.includes("\r\n");
  src = src.replace(/\r\n/g, "\n");

  if (src.includes("struct FragOutput")) {
    console.log(`  skip (already wired): ${FILE}`);
    return;
  }

  // 1. Insert struct + helper right before @fragment.
  const fragIdx = src.indexOf("@fragment\nfn fragmentMain");
  if (fragIdx < 0) {
    console.log("  FAIL: couldn't find @fragment\\nfn fragmentMain");
    process.exit(1);
  }
  src = src.slice(0, fragIdx) + FRAG_STRUCT_AND_HELPER + src.slice(fragIdx);

  // 2. Change the function signature.
  src = src.replace(
    /@fragment\nfn fragmentMain\(input: VertexOutput\) -> @location\(0\) vec4<f32> \{/,
    "@fragment\nfn fragmentMain(input: VertexOutput) -> FragOutput {",
  );

  // 3. Extract the fragmentMain body so we only patch returns inside it,
  // not in helpers above. Find the function start, then scan brace
  // depth to find the matching close.
  const fnStart = src.indexOf(
    "fn fragmentMain(input: VertexOutput) -> FragOutput {",
  );
  if (fnStart < 0) {
    console.log("  FAIL: couldn't find updated fragmentMain signature");
    process.exit(1);
  }
  // Position of the open `{` after the signature.
  const openBrace = src.indexOf("{", fnStart);
  let depth = 1;
  let i = openBrace + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) break;
    i++;
  }
  const closeBrace = i;

  const beforeBody = src.slice(0, openBrace + 1);
  let body = src.slice(openBrace + 1, closeBrace);
  const afterBody = src.slice(closeBrace);

  // 4. Replace every `return <expr>;` in the body with the wrapped form.
  // Use a multi-line lazy match for expressions that span lines (some
  // returns are multi-line vec4 constructors).
  let replacedCount = 0;
  body = body.replace(
    /(\s)return\s+([\s\S]*?);(\s)/g,
    (_match, leadingWs, expr, trailingWs) => {
      replacedCount++;
      return `${leadingWs}return makeFragOutput(${expr.trim()}, input.v_normalEC);${trailingWs}`;
    },
  );

  src = beforeBody + body + afterBody;

  // Round-trip back to CRLF if the source used them.
  if (hadCRLF) src = src.replace(/\n/g, "\r\n");

  fs.writeFileSync(FILE, src, "utf8");
  console.log(`  wired: ${FILE} (${replacedCount} returns rewrapped)`);
}

console.log("[wire-globe-mrt-normal] patching GlobeTerrain.wgsl");
patch();
console.log("[wire-globe-mrt-normal] done");
