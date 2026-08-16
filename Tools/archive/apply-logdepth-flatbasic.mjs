// One-shot transform: add the LOG_DEPTH //>>ifdef blocks to the Mat*Flat +
// Basic primitive shaders (the `@builtin(position) position` + bare
// `-> @location(0) vec4<f32>` return family). Because these shaders return a
// bare vec4 rather than a struct, the LOG_DEPTH path swaps the fragmentMain
// signature to a `FragOut` struct (color + frag_depth) and rewrites every
// fragmentMain `return X;` to `return FragOut(X, <logdepth>);`. The //>>else
// branch keeps the historical bare-vec4 path so LOG_DEPTH-off is byte-identical.
// @purpose One-shot codemod adding LOG_DEPTH //>>ifdef blocks + FragOut struct swap to the 21 Mat*Flat/Basic WGSL primitive shaders.
// @status INVESTIGATION
//
// Idempotent: skips files that already carry v_logDepth.
import fs from "node:fs";
import path from "node:path";

const DIR = "packages/engine/Source/Shaders/WebGPU/Primitive";
const files = [
  "PrimitiveMatAlphaMapFlat",
  "PrimitiveMatAspectRampFlat",
  "PrimitiveMatBumpMapFlat",
  "PrimitiveMatCheckerFlat",
  "PrimitiveMatColorFlat",
  "PrimitiveMatDotFlat",
  "PrimitiveMatElevBandFlat",
  "PrimitiveMatElevContourFlat",
  "PrimitiveMatElevRampFlat",
  "PrimitiveMatEmissionMapFlat",
  "PrimitiveMatFadeFlat",
  "PrimitiveMatGridFlat",
  "PrimitiveMatImageFlat",
  "PrimitiveMatNormalMapFlat",
  "PrimitiveMatRimLightingFlat",
  "PrimitiveMatSlopeRampFlat",
  "PrimitiveMatSpecularMapFlat",
  "PrimitiveMatStripeFlat",
  "PrimitiveMatWaterFlat",
  "PrimitiveBasicColor",
  "PrimitiveBasicTexturedColor",
].map((n) => `${n}.wgsl`);

// VertexOutput: append v_logDepth varying before the struct close. These shaders
// end VertexOutput with `@location(N) eyePosition: vec3<f32>,` (the last varying
// every Flat/Basic carries for the aerial-LUT fog block).
const VARYING_BLOCK = `    //>>ifdef LOG_DEPTH
    // Interpolated linear depthFromNearPlusOne; the FS converts it to frag_depth.
    @location(7) v_logDepth: f32,
    //>>endif
`;

// CameraUniforms: short flat layout. logDepth tail after previousViewProjection.
// Packed by writeRTEUniformsFlat into the FLAT UB tail (floats 40-43;
// FLAT_CAMERA_BYTES 160 -> 176). See WebGPULogDepth.ts.
const CAMERA_TAIL = `    previousViewProjection: mat4x4<f32>,
    //>>ifdef LOG_DEPTH
    // ─── Renderer-wide log depth (Approach A) ───
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved. Packed by WebGPUPrimitiveCommands.writeRTEUniformsFlat
    // into the 16-byte FLAT UB tail (FLAT_CAMERA_BYTES 160 -> 176).
    logDepth: vec4<f32>,
    //>>endif
`;

const HELPERS_BLOCK = `//>>ifdef LOG_DEPTH
// Renderer-wide log depth (Approach A). Mirror of PrimitivePhongColor.wgsl —
// keep byte-compatible. near/far/factor come from camera.logDepth. The FS swaps
// to a FragOut struct so it can write @builtin(frag_depth) alongside the color.
struct FragOut {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
}
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

// vertexMain: compute the varying + clamp clip-z (builtin is `position`).
const VS_BLOCK = `    //>>ifdef LOG_DEPTH
    // Renderer-wide log depth: interpolate linear depthFromNearPlusOne and clamp
    // clip-z so the FS-written log depth isn't pre-empted by clipping.
    output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
    output.position = csm_updatePositionDepth(output.position);
    //>>endif
    return output;`;

// fragmentMain signature: dual — FragOut when LOG_DEPTH, bare vec4 otherwise.
const SIG_OLD =
  "@fragment\nfn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {";
const SIG_NEW = `@fragment
//>>ifdef LOG_DEPTH
fn fragmentMain(input: VertexOutput) -> FragOut {
//>>else
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
//>>endif
    //>>ifdef LOG_DEPTH
    g_fragLogDepth = input.v_logDepth;
    //>>endif`;

let changed = 0;
for (const file of files) {
  const fp = path.join(DIR, file);
  const raw = fs.readFileSync(fp, "utf8");
  if (raw.includes("v_logDepth")) {
    console.log(`SKIP (already has log depth): ${file}`);
    continue;
  }
  // The shader dir has MIXED line endings (Mat*Lit are LF, Mat*Flat are CRLF).
  // Normalize to LF for the transform, then restore the file's original EOL on
  // write so the diff is just the inserted lines (no whole-file EOL churn).
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  let src = raw.replace(/\r\n/g, "\n");

  // 1a. Pre-existing Batch-97 bug fix: 18 of the 19 Mat*Flat shaders WRITE
  //     `output.eyePosition` in vertexMain and READ `input.eyePosition` in the
  //     aerial-LUT fog block, but never DECLARE the varying in VertexOutput —
  //     so they fail WGSL `createShaderModule` the moment a `flat:true` material
  //     primitive renders. Add the missing declaration (only when used and not
  //     already declared) so the Flat path actually compiles and the log-depth
  //     //>>else branch is genuinely byte-identical-working, not byte-identical-
  //     broken. ColorFlat already carries it (the one shader Batch 97 got right).
  const voBlock = src.match(/struct VertexOutput \{\n[\s\S]*?\n\}/)[0];
  const usesEye =
    src.includes("output.eyePosition") || src.includes("input.eyePosition");
  if (usesEye && !voBlock.includes("eyePosition")) {
    const nextLoc =
      Math.max(
        -1,
        ...(voBlock.match(/@location\((\d+)\)/g) || []).map((s) =>
          parseInt(s.match(/\d+/)[0], 10),
        ),
      ) + 1;
    const eyeDecl = `    // FEAT-GAP-09 — eye-space position for the aerial-perspective fog block.
    // Declaration restored (Batch 97 wired the read/write but omitted the
    // VertexOutput field in 18 of 19 Mat*Flat shaders).
    @location(${nextLoc}) eyePosition: vec3<f32>,\n`;
    src = src.replace(voBlock, voBlock.replace(/\n\}$/, `\n${eyeDecl}}`));
  }

  // 1b. Varying — insert before the VertexOutput struct's closing brace. Anchor
  //    generically on the struct body so it works regardless of which varyings
  //    the shader declares (some Flat shaders carry only texCoord).
  const voMatch = src.match(/(struct VertexOutput \{\n[\s\S]*?\n)(\})/);
  if (!voMatch) throw new Error(`VertexOutput struct not found in ${file}`);
  src = src.replace(voMatch[0], `${voMatch[1]}${VARYING_BLOCK}${voMatch[2]}`);

  // 2. CameraUniforms tail.
  const camMatch = src.match(/ {4}previousViewProjection: mat4x4<f32>,\n(\})/);
  if (!camMatch)
    throw new Error(`CameraUniforms prevVP anchor not found in ${file}`);
  src = src.replace(camMatch[0], `${CAMERA_TAIL}${camMatch[1]}`);

  // 3. Helpers + FragOut struct — before the first translateRelativeToEye fn.
  const trIdx = src.indexOf(
    "fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>)",
  );
  if (trIdx < 0) throw new Error(`translateRelativeToEye not found in ${file}`);
  src = src.slice(0, trIdx) + HELPERS_BLOCK + src.slice(trIdx);

  // 4. vertexMain — replace the lone `    return output;`.
  if ((src.match(/\n {4}return output;/g) || []).length !== 1)
    throw new Error(`expected exactly one 'return output;' in ${file}`);
  src = src.replace("\n    return output;", `\n${VS_BLOCK}`);

  // 5. fragmentMain signature → dual + stash.
  if (!src.includes(SIG_OLD))
    throw new Error(`fragmentMain signature not found in ${file}`);
  src = src.replace(SIG_OLD, SIG_NEW);

  // 6. fragmentMain return sites. The only returns AFTER the fragmentMain
  //    signature are the bare-vec4 returns we must wrap. Walk from the signature
  //    forward and gate each `return <expr>;`.
  const sigIdx = src.indexOf(
    "fn fragmentMain(input: VertexOutput) -> FragOut {",
  );
  const head = src.slice(0, sigIdx);
  let body = src.slice(sigIdx);
  // Gate `return finalColor;` (4-space, final) and `return effects.clippingEdgeColor;`
  // (12-space, BasicColor early-out). Both are the ONLY returns in the fragment
  // body (helper fns are all above the signature).
  body = body.replace(
    /(\n(\s+)return )([^;]+)(;)/g,
    (m, pre, indent, expr, semi) =>
      `\n${indent}//>>ifdef LOG_DEPTH\n` +
      `${indent}return FragOut(${expr}, csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z));\n` +
      `${indent}//>>else\n` +
      `${indent}return ${expr};\n` +
      `${indent}//>>endif`,
  );
  src = head + body;

  // Restore the file's original EOL.
  if (eol === "\r\n") src = src.replace(/\n/g, "\r\n");
  fs.writeFileSync(fp, src, "utf8");
  console.log(`OK: ${file} (eol=${eol === "\r\n" ? "CRLF" : "LF"})`);
  changed++;
}
console.log(`\nDone. ${changed} files changed.`);
