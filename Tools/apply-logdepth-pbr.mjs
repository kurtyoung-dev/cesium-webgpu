// One-shot transform: add the LOG_DEPTH //>>ifdef blocks to the PBR primitive
// shaders (PrimitivePBRSimple / PrimitivePBRTextured). These use the
// `@builtin(position) clipPosition` builtin (like Mat*Lit) but return a bare
// `@location(0) vec4<f32>` (like the Flat family), and carry many helper-fn
// returns BEFORE fragmentMain. So we use the clipPosition VS treatment + the
// FragOut struct-swap return treatment, scoping return-wrapping to the
// fragmentMain body only. Camera UB is the LIT layout (logDepth tail at floats
// 76-79, already packed by writeRTEUniformsLit). //>>else stays byte-identical.
import fs from "node:fs";
import path from "node:path";

const DIR = "packages/engine/Source/Shaders/WebGPU/Primitive";
const files = ["PrimitivePBRSimple", "PrimitivePBRTextured"].map((n) => `${n}.wgsl`);

const VARYING_BLOCK = `    //>>ifdef LOG_DEPTH
    // Interpolated linear depthFromNearPlusOne; the FS converts it to frag_depth.
    @location(7) v_logDepth: f32,
    //>>endif
`;

const CAMERA_TAIL = `    previousViewProjection: mat4x4<f32>,
    //>>ifdef LOG_DEPTH
    // ─── Renderer-wide log depth (Approach A) ───
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved. Packed by WebGPUPrimitiveCommands.writeRTEUniformsLit
    // into the 16-byte LIT UB tail (LIT_CAMERA_BYTES 304 -> 320).
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

const VS_BLOCK = `    //>>ifdef LOG_DEPTH
    // Renderer-wide log depth: interpolate linear depthFromNearPlusOne and clamp
    // clip-z so the FS-written log depth isn't pre-empted by clipping.
    output.v_logDepth = csm_vertexLogDepth(output.clipPosition, camera.logDepth.x);
    output.clipPosition = csm_updatePositionDepth(output.clipPosition);
    //>>endif
    return output;`;

const SIG_OLD = "@fragment\nfn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {";
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
  let raw = fs.readFileSync(fp, "utf8");
  if (raw.includes("v_logDepth")) {
    console.log(`SKIP (already has log depth): ${file}`);
    continue;
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  let src = raw.replace(/\r\n/g, "\n");

  // 1. Varying — before VertexOutput close brace.
  const voMatch = src.match(/(struct VertexOutput \{\n[\s\S]*?\n)(\})/);
  if (!voMatch) throw new Error(`VertexOutput struct not found in ${file}`);
  src = src.replace(voMatch[0], `${voMatch[1]}${VARYING_BLOCK}${voMatch[2]}`);

  // 2. CameraUniforms tail.
  const camMatch = src.match(/    previousViewProjection: mat4x4<f32>,\n(\})/);
  if (!camMatch) throw new Error(`CameraUniforms prevVP anchor not found in ${file}`);
  src = src.replace(camMatch[0], `${CAMERA_TAIL}${camMatch[1]}`);

  // 3. Helpers + FragOut struct — before the first translateRelativeToEye fn.
  const trIdx = src.indexOf("fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>)");
  if (trIdx < 0) throw new Error(`translateRelativeToEye not found in ${file}`);
  src = src.slice(0, trIdx) + HELPERS_BLOCK + src.slice(trIdx);

  // 4. vertexMain — replace the lone `    return output;`.
  if ((src.match(/\n    return output;/g) || []).length !== 1)
    throw new Error(`expected exactly one 'return output;' in ${file}`);
  src = src.replace("\n    return output;", `\n${VS_BLOCK}`);

  // 5. fragmentMain signature → dual + stash.
  if (!src.includes(SIG_OLD)) throw new Error(`fragmentMain signature not found in ${file}`);
  src = src.replace(SIG_OLD, SIG_NEW);

  // 6. fragmentMain return — only the body after the fragmentMain signature has
  //    the single `return finalColor;` we must wrap (all helper-fn returns are
  //    above the signature).
  const sigIdx = src.indexOf("fn fragmentMain(input: VertexOutput) -> FragOut {");
  const head = src.slice(0, sigIdx);
  let body = src.slice(sigIdx);
  if ((body.match(/\n    return finalColor;/g) || []).length !== 1)
    throw new Error(`expected exactly one 'return finalColor;' in fragmentMain of ${file}`);
  body = body.replace(
    "\n    return finalColor;",
    "\n    //>>ifdef LOG_DEPTH\n" +
    "    return FragOut(finalColor, csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z));\n" +
    "    //>>else\n" +
    "    return finalColor;\n" +
    "    //>>endif",
  );
  src = head + body;

  if (eol === "\r\n") src = src.replace(/\n/g, "\r\n");
  fs.writeFileSync(fp, src, "utf8");
  console.log(`OK: ${file} (eol=${eol === "\r\n" ? "CRLF" : "LF"})`);
  changed++;
}
console.log(`\nDone. ${changed} files changed.`);
