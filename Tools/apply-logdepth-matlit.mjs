// One-shot transform: add the LOG_DEPTH //>>ifdef blocks to the Mat*Lit
// primitive shaders (clipPosition builtin + FragOutput struct family).
// Mirrors the canonical PrimitivePhongColor.wgsl log-depth recipe. The
// //>>else branch keeps the historical hyperbolic path so LOG_DEPTH-off
// is byte-identical. Idempotent: skips files that already carry v_logDepth.
import fs from "node:fs";
import path from "node:path";

const DIR = "packages/engine/Source/Shaders/WebGPU/Primitive";
const files = [
  "PrimitiveMatAlphaMapLit",
  "PrimitiveMatAspectRampLit",
  "PrimitiveMatBumpMapLit",
  "PrimitiveMatCheckerLit",
  "PrimitiveMatColorLit",
  "PrimitiveMatDotLit",
  "PrimitiveMatElevBandLit",
  "PrimitiveMatElevContourLit",
  "PrimitiveMatElevRampLit",
  "PrimitiveMatEmissionMapLit",
  "PrimitiveMatFadeLit",
  "PrimitiveMatGridLit",
  "PrimitiveMatImageLit",
  "PrimitiveMatNormalMapLit",
  "PrimitiveMatRimLightingLit",
  "PrimitiveMatSlopeRampLit",
  "PrimitiveMatSpecularMapLit",
  "PrimitiveMatStripeLit",
  "PrimitiveMatWaterLit",
].map((n) => `${n}.wgsl`);

// 1. VertexOutput: insert v_logDepth varying before the struct's closing brace.
//    Anchored on the eyePosition varying which every Mat*Lit carries as its
//    last @location. We append a new line right after it.
const VARYING_BLOCK = `
    //>>ifdef LOG_DEPTH
    // Interpolated linear depthFromNearPlusOne; the FS converts it to frag_depth.
    @location(7) v_logDepth: f32,
    //>>endif`;

// 2. CameraUniforms: add the logDepth tail after previousViewProjection.
const CAMERA_TAIL = `    previousViewProjection: mat4x4<f32>,
    //>>ifdef LOG_DEPTH
    // ─── Renderer-wide log depth (Approach A) ───
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved. Packed by WebGPUPrimitiveCommands.writeRTEUniformsLit
    // into the 16-byte tail appended after previousViewProjection
    // (LIT_CAMERA_BYTES 304 -> 320). See WebGPULogDepth.ts.
    logDepth: vec4<f32>,
    //>>endif
`;

// 3. Inline helpers + private accumulator, inserted right before the first
//    `fn translateRelativeToEye` definition (present in every shader).
const HELPERS_BLOCK = `//>>ifdef LOG_DEPTH
// Renderer-wide log depth (Approach A). These mirror the canonical definitions
// in PrimitivePhongColor.wgsl / Shaders/WebGPU/chunks/functions/csm_*LogDepth —
// keep them byte-compatible. near/far/factor come from camera.logDepth.
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
    return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
    var coords = clipPosition;
    coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
    return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
    return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
// Per-fragment interpolated depthFromNearPlusOne, stashed by fragmentMain.
var<private> g_fragLogDepth: f32;
//>>endif

`;

// 4. vertexMain: compute the varying + clamp clip-z just before `return output;`.
const VS_BLOCK = `
    //>>ifdef LOG_DEPTH
    // Renderer-wide log depth: interpolate linear depthFromNearPlusOne and clamp
    // clip-z so the FS-written log depth isn't pre-empted by clipping. near =
    // camera.logDepth.x; computed from clipPosition.w BEFORE the clamp.
    output.v_logDepth = csm_vertexLogDepth(output.clipPosition, camera.logDepth.x);
    output.clipPosition = csm_updatePositionDepth(output.clipPosition);
    //>>endif
    return output;`;

// 5. FragOutput struct: add the frag_depth builtin slot.
const FRAGOUT_BLOCK = `    @location(1) normalRoughness: vec4<f32>,
    //>>ifdef LOG_DEPTH
    @builtin(frag_depth) depth: f32,
    //>>endif`;

let changed = 0;
for (const file of files) {
  const fp = path.join(DIR, file);
  let src = fs.readFileSync(fp, "utf8");
  if (src.includes("v_logDepth")) {
    console.log(`SKIP (already has log depth): ${file}`);
    continue;
  }

  // 1. Varying — insert after the eyePosition varying line inside VertexOutput.
  //    Match the eyePosition @location line (whatever its index) that ends the
  //    VertexOutput struct, then the closing brace.
  const voMatch = src.match(
    /(struct VertexOutput \{[\s\S]*?@location\(\d+\) eyePosition: vec3<f32>,\n)(\})/,
  );
  if (!voMatch)
    throw new Error(`VertexOutput eyePosition anchor not found in ${file}`);
  src = src.replace(
    voMatch[0],
    `${voMatch[1]}${VARYING_BLOCK.replace(/^\n/, "")}\n${voMatch[2]}`,
  );

  // 2. CameraUniforms tail — replace the prevVP line + the struct close brace.
  const camMatch = src.match(/ {4}previousViewProjection: mat4x4<f32>,\n(\})/);
  if (!camMatch)
    throw new Error(`CameraUniforms prevVP anchor not found in ${file}`);
  src = src.replace(camMatch[0], `${CAMERA_TAIL}${camMatch[1]}`);

  // 3. Helpers — insert before the first translateRelativeToEye fn.
  const trIdx = src.indexOf(
    "fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>)",
  );
  if (trIdx < 0) throw new Error(`translateRelativeToEye not found in ${file}`);
  src = src.slice(0, trIdx) + HELPERS_BLOCK + src.slice(trIdx);

  // 4. vertexMain — replace the lone `    return output;`.
  if ((src.match(/\n {4}return output;/g) || []).length !== 1)
    throw new Error(`expected exactly one 'return output;' in ${file}`);
  src = src.replace("\n    return output;", `\n${VS_BLOCK}`);

  // 5. FragOutput struct — add frag_depth after normalRoughness.
  if (!src.includes(FRAGOUT_BLOCK.split("\n")[0]))
    throw new Error(`normalRoughness anchor not found in ${file}`);
  src = src.replace(
    "    @location(1) normalRoughness: vec4<f32>,",
    FRAGOUT_BLOCK,
  );

  // 6. fragmentMain — stash g_fragLogDepth at the very top of the body, and
  //    write frag_depth at the single `return mrtOut;`.
  const fmMatch = src.match(
    /(@fragment\nfn fragmentMain\(input: VertexOutput\) -> FragOutput \{\n)/,
  );
  if (!fmMatch)
    throw new Error(`fragmentMain signature anchor not found in ${file}`);
  const stash = `${fmMatch[1]}    //>>ifdef LOG_DEPTH\n    g_fragLogDepth = input.v_logDepth;\n    //>>endif\n`;
  src = src.replace(fmMatch[1], stash);

  if ((src.match(/\n {4}return mrtOut;/g) || []).length !== 1)
    throw new Error(`expected exactly one 'return mrtOut;' in ${file}`);
  src = src.replace(
    "\n    return mrtOut;",
    "\n    //>>ifdef LOG_DEPTH\n" +
      "    // Write logarithmic frag depth. factor = camera.logDepth.z.\n" +
      "    mrtOut.depth = csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z);\n" +
      "    //>>endif\n" +
      "    return mrtOut;",
  );

  fs.writeFileSync(fp, src, "utf8");
  console.log(`OK: ${file}`);
  changed++;
}
console.log(`\nDone. ${changed} files changed.`);
